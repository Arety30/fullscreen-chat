// Global state variables
let currentTab = 'console';
let sessions = [];
let selectedSessionId = null;
let activeSessionPoll = null;
let logPollInterval = null;
let statusPollInterval = null;
let lastLogLineCount = 0;

// Component Designer State
let canvasElements = [];
let selectedElementId = null;

// On Page Load Initialization
window.addEventListener('DOMContentLoaded', () => {
  // Setup Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }
  
  // Initialize panels
  switchTab('console');
  refreshSessions();
  loadDefaultTemplate();

  // Start polling loops
  startPollingLogs();
  startPollingStatus();
});

// ----------------------------------------------------
// TAB SYSTEM NAVIGATION
// ----------------------------------------------------
function switchTab(tabName) {
  currentTab = tabName;
  
  const consoleTab = document.getElementById('tab-content-console');
  const designerTab = document.getElementById('tab-content-designer');
  const consoleBtn = document.getElementById('btn-tab-console');
  const designerBtn = document.getElementById('btn-tab-designer');
  
  if (tabName === 'console') {
    consoleTab.classList.remove('hidden');
    designerTab.classList.add('hidden');
    consoleBtn.classList.add('active');
    designerBtn.classList.remove('active');
  } else {
    consoleTab.classList.add('hidden');
    designerTab.classList.remove('hidden');
    consoleBtn.classList.remove('active');
    designerBtn.classList.add('active');
    renderCanvas();
  }
}

// ----------------------------------------------------
// OPERATOR CONSOLE LOG STREAM
// ----------------------------------------------------
function startPollingLogs() {
  // Clear any existing logs poll
  if (logPollInterval) clearInterval(logPollInterval);
  
  fetchLogs(); // initial load
  logPollInterval = setInterval(fetchLogs, 1500);
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) throw new Error("Log fetch failure");
    
    const data = await res.json();
    const terminal = document.getElementById('terminal-output');
    const autoscroll = document.getElementById('terminal-autoscroll').checked;
    
    if (data.lines && data.lines.length > 0) {
      // If server returned different content or lines count changed
      if (data.lines.length !== lastLogLineCount) {
        lastLogLineCount = data.lines.length;
        terminal.innerHTML = '';
        
        data.lines.forEach(line => {
          const lineDiv = document.createElement('div');
          lineDiv.className = 'py-0.5 whitespace-pre-wrap leading-relaxed';
          
          // Format line colors based on level
          let styledText = line;
          
          // Pattern: 2026-06-20 12:21:34.991 | LEVEL | ...
          const parts = line.split(' | ');
          if (parts.length >= 2) {
            const timePart = parts[0];
            const levelPart = parts[1].trim();
            const restPart = parts.slice(2).join(' | ');
            
            let levelClass = 'term-info';
            if (levelPart.includes('ERROR') || levelPart.includes('CRITICAL')) {
              levelClass = 'term-error';
            } else if (levelPart.includes('WARNING')) {
              levelClass = 'term-warning';
            } else if (levelPart.includes('SUCCESS')) {
              levelClass = 'term-success';
            } else if (levelPart.includes('DEBUG')) {
              levelClass = 'term-debug';
            }
            
            styledText = `<span class="term-timestamp">${timePart}</span> | <span class="${levelClass} font-bold">${levelPart}</span> | <span>${escapeHtml(restPart)}</span>`;
          } else {
            styledText = escapeHtml(line);
          }
          
          lineDiv.innerHTML = styledText;
          terminal.appendChild(lineDiv);
        });
        
        if (autoscroll) {
          terminal.scrollTop = terminal.scrollHeight;
        }
      }
    } else {
      terminal.innerHTML = '<div class="text-slate-500 italic">No OpenManus execution logs found yet. Start an agent command to generate output.</div>';
    }
  } catch (err) {
    console.error("Error fetching logs:", err);
  }
}

function clearTerminal() {
  document.getElementById('terminal-output').innerHTML = '<div class="text-slate-500 italic">Terminal buffer cleared manually.</div>';
  lastLogLineCount = 0;
}

// ----------------------------------------------------
// WEBHOOK MONITORING & LOCAL EXECUTION
// ----------------------------------------------------
function startPollingStatus() {
  if (statusPollInterval) clearInterval(statusPollInterval);
  
  fetchStatus();
  statusPollInterval = setInterval(fetchStatus, 2000);
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error("Status API issue");
    const data = await res.json();
    
    // Update Gateway Header Status
    const gatewayStatus = document.getElementById('gateway-status');
    if (data.gateway === 'healthy') {
      gatewayStatus.textContent = 'ONLINE';
      gatewayStatus.className = 'text-emerald-400 font-bold';
    } else {
      gatewayStatus.textContent = 'OFFLINE';
      gatewayStatus.className = 'text-red-400 font-bold';
    }
    
    // Update tracking stats
    document.getElementById('stat-correlation-id').textContent = data.correlation_id || '--';
    document.getElementById('stat-request-id').textContent = data.request_id || '--';
    
    const intentText = document.getElementById('stat-intent-text');
    const intentDot = document.getElementById('intent-dot');
    const n8nInfo = document.getElementById('stat-n8n-info');
    
    if (data.intent && data.intent !== 'idle') {
      intentText.textContent = data.intent.toUpperCase();
      intentDot.className = 'w-2 h-2 rounded-full bg-cyan-400 animate-pulse';
      
      // Update background task source status if available
      n8nInfo.textContent = data.n8n_info || 'Local Integrator Route';
    } else {
      intentText.textContent = 'IDLE';
      intentDot.className = 'w-2 h-2 rounded-full bg-slate-600';
      n8nInfo.textContent = 'Listening for incoming webhooks...';
    }
  } catch (err) {
    console.error("Error reading gateway status:", err);
    document.getElementById('gateway-status').textContent = 'CONNECTION ERROR';
    document.getElementById('gateway-status').className = 'text-yellow-500 font-bold';
  }
}

async function triggerLocalExecution(e) {
  e.preventDefault();
  
  const inputEl = document.getElementById('execution-task-input');
  const btnEl = document.getElementById('btn-submit-execution');
  const task = inputEl.value.trim();
  
  if (!task) return;
  
  // Update state to busy
  inputEl.disabled = true;
  btnEl.disabled = true;
  btnEl.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Triggering...`;
  if (window.lucide) window.lucide.createIcons();
  
  try {
    const res = await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: task })
    });
    
    const data = await res.json();
    
    // Trigger logs pull and session list pull immediately
    setTimeout(() => {
      fetchLogs();
      refreshSessions();
    }, 1000);
    
    inputEl.value = '';
  } catch (err) {
    console.error("Error triggering execution task:", err);
    alert("Backend Server failed to handle task request. Make sure orchestrator.py is online.");
  } finally {
    inputEl.disabled = false;
    btnEl.disabled = false;
    btnEl.innerHTML = `<i data-lucide="play" class="w-4 h-4"></i> Execute Task`;
    if (window.lucide) window.lucide.createIcons();
  }
}

// ----------------------------------------------------
// SESSION HISTORY & INSPECTION SIDEBAR
// ----------------------------------------------------
async function refreshSessions() {
  const btn = document.getElementById('btn-refresh-sessions');
  if (btn) btn.classList.add('animate-spin');
  
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error("Sessions fetch issue");
    
    sessions = await res.json();
    renderSessionList();
  } catch (err) {
    console.error("Error updating sessions:", err);
    document.getElementById('session-list').innerHTML = `
      <div class="p-6 text-center text-xs text-red-400">
        <i data-lucide="alert-triangle" class="w-6 h-6 mx-auto mb-2"></i>
        Failed to fetch sessions from memory/state
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  } finally {
    if (btn) btn.classList.remove('animate-spin');
  }
}

function renderSessionList() {
  const container = document.getElementById('session-list');
  const searchFilter = document.getElementById('session-search').value.toLowerCase().trim();
  
  const filtered = sessions.filter(s => s.session_id.toLowerCase().includes(searchFilter));
  
  if (filtered.length === 0) {
    container.innerHTML = `<div class="p-8 text-center text-xs text-slate-500">No active session memory states.</div>`;
    return;
  }
  
  container.innerHTML = '';
  filtered.forEach(session => {
    const activeClass = session.session_id === selectedSessionId ? 'bg-slate-800 border-l-4 border-l-brand-500' : 'bg-slate-900/20 border-l-4 border-l-transparent';
    const timeFormatted = formatIsoTime(session.updated_at);
    
    const div = document.createElement('div');
    div.className = `p-3 rounded-lg hover:bg-slate-800/60 cursor-pointer transition-all duration-200 border-b border-slate-850/50 ${activeClass}`;
    div.onclick = () => selectSession(session.session_id);
    
    div.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-mono font-bold text-slate-200 truncate flex-1" title="${session.session_id}">${session.session_id}</span>
        <span class="text-[9px] bg-slate-950 text-slate-400 px-1.5 py-0.5 rounded border border-slate-850 font-semibold">${session.estimated_tokens || 0} tokens</span>
      </div>
      <div class="flex justify-between items-center mt-2 text-[10px] text-slate-500">
        <span class="truncate max-w-[120px] font-medium text-slate-400">${session.last_message_excerpt || 'Empty context'}</span>
        <span class="text-[9px] font-mono shrink-0">${timeFormatted}</span>
      </div>
    `;
    container.appendChild(div);
  });
}

// Bind search input filter
document.getElementById('session-search').addEventListener('input', renderSessionList);

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderSessionList(); // refresh selection visual classes
  
  const badge = document.getElementById('session-badge');
  badge.textContent = sessionId.substring(0, 12) + (sessionId.length > 12 ? '...' : '');
  badge.title = sessionId;
  badge.className = "px-2 py-0.5 rounded text-[10px] font-bold bg-brand-900/60 border border-brand-700 text-brand-400";
  
  const pane = document.getElementById('session-detail-pane');
  pane.innerHTML = `
    <div class="flex flex-col items-center justify-center py-12 text-slate-500 text-xs">
      <i data-lucide="loader" class="w-6 h-6 animate-spin text-brand-500 mb-2"></i>
      Loading session details...
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();
  
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) throw new Error("Failed to load details");
    const data = await res.json();
    
    renderSessionDetail(data);
  } catch (err) {
    pane.innerHTML = `
      <div class="p-6 text-center text-xs text-red-400">
        <i data-lucide="alert-triangle" class="w-6 h-6 mx-auto mb-2"></i>
        Error loading state file details
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderSessionDetail(data) {
  const pane = document.getElementById('session-detail-pane');
  pane.innerHTML = '';
  
  // Section: Session Info
  const headerDiv = document.createElement('div');
  headerDiv.className = 'bg-slate-950 p-3.5 rounded-xl border border-slate-850 space-y-2';
  headerDiv.innerHTML = `
    <div class="flex justify-between text-[11px]">
      <span class="text-slate-500 font-bold uppercase">Created at</span>
      <span class="text-slate-300 font-mono">${formatIsoTime(data.created_at)}</span>
    </div>
    <div class="flex justify-between text-[11px]">
      <span class="text-slate-500 font-bold uppercase">Context Limit</span>
      <span class="text-slate-300 font-mono">${data.context_token_limit} tokens</span>
    </div>
    <div class="flex justify-between text-[11px]">
      <span class="text-slate-500 font-bold uppercase">Total Consumed</span>
      <span class="text-brand-400 font-bold font-mono">${data.estimated_tokens || 0} tokens</span>
    </div>
  `;
  pane.appendChild(headerDiv);
  
  // Section: Summaries Context
  if (data.summaries && data.summaries.length > 0) {
    const sumDiv = document.createElement('div');
    sumDiv.className = 'space-y-2';
    sumDiv.innerHTML = `<h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
      <i data-lucide="file-text" class="w-4 h-4 text-emerald-500"></i> Condensed Context Summary (${data.summaries.length})
    </h4>`;
    
    data.summaries.forEach(sum => {
      const card = document.createElement('div');
      card.className = 'bg-slate-900/60 border border-emerald-950/40 p-3 rounded-lg text-xs leading-relaxed text-emerald-300/80';
      card.innerHTML = `
        <div class="text-[9px] text-emerald-500 font-semibold mb-1 uppercase tracking-wider">Merged Memory Summary</div>
        <div>${escapeHtml(sum.content)}</div>
      `;
      sumDiv.appendChild(card);
    });
    pane.appendChild(sumDiv);
  }
  
  // Section: Execution Turns / Event Logs
  if (data.history && data.history.length > 0) {
    const histDiv = document.createElement('div');
    histDiv.className = 'space-y-3';
    histDiv.innerHTML = `<h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
      <i data-lucide="message-square" class="w-4 h-4 text-accent-blue"></i> Conversation History Logs
    </h4>`;
    
    data.history.forEach(turn => {
      const card = document.createElement('div');
      
      let borderClass = 'border-slate-850 bg-slate-900/20';
      let titleClass = 'text-slate-400';
      let icon = 'user';
      let roleLabel = turn.role.toUpperCase();
      
      if (turn.role === 'assistant') {
        borderClass = 'border-brand-900/30 bg-brand-950/10';
        titleClass = 'text-brand-400';
        icon = 'bot';
      } else if (turn.role === 'system') {
        borderClass = 'border-red-950/30 bg-red-950/5';
        titleClass = 'text-red-400';
        icon = 'alert-octagon';
      }
      
      card.className = `border ${borderClass} p-3.5 rounded-xl space-y-2 text-xs leading-relaxed`;
      card.innerHTML = `
        <div class="flex justify-between items-center text-[10px]">
          <span class="font-bold uppercase tracking-wider ${titleClass} flex items-center gap-1.5">
            <i data-lucide="${icon}" class="w-3.5 h-3.5"></i> ${roleLabel}
          </span>
          <span class="text-slate-500 font-mono text-[9px]">${formatIsoTime(turn.created_at)}</span>
        </div>
        <div class="text-slate-200 break-words whitespace-pre-wrap">${escapeHtml(turn.content)}</div>
      `;
      histDiv.appendChild(card);
    });
    pane.appendChild(histDiv);
  } else {
    const emptyHistory = document.createElement('div');
    emptyHistory.className = 'text-xs text-slate-500 text-center py-4';
    emptyHistory.textContent = 'No messages appended to this session yet.';
    pane.appendChild(emptyHistory);
  }
  
  if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// UI COMPONENT DESIGNER CANVAS
// ----------------------------------------------------
function addComponent(type) {
  const id = 'el-' + Date.now();
  let text = '';
  let classes = '';
  let binding = '';
  let trigger = '';
  
  switch (type) {
    case 'button':
      text = 'Trigger Subagent Action';
      classes = 'px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-slate-100 font-bold rounded-xl text-xs transition-colors duration-200';
      trigger = 'alert("Triggering subagent route...")';
      break;
    case 'input':
      text = 'Enter correlation override...';
      classes = 'w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 placeholder-slate-600';
      binding = 'correlation_id';
      break;
    case 'textarea':
      text = 'Enter system instruction...';
      classes = 'w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 placeholder-slate-600 h-20';
      binding = 'task';
      break;
    case 'header':
      text = 'Agent Dashboard Visual Input';
      classes = 'text-base font-extrabold font-outfit text-slate-200 border-b border-slate-850 pb-1.5';
      break;
  }
  
  canvasElements.push({ id, type, text, classes, binding, trigger });
  renderCanvas();
  selectElement(id);
}

function renderCanvas() {
  const canvas = document.getElementById('designer-canvas');
  const placeholder = document.getElementById('canvas-placeholder');
  
  // Clear layout but keep template placeholder if elements empty
  if (canvasElements.length === 0) {
    placeholder.classList.remove('hidden');
    canvas.querySelectorAll('.canvas-element').forEach(el => el.remove());
    document.getElementById('code-output').textContent = '<!-- Canvas is empty. Add elements to generate layout code -->';
    return;
  }
  
  placeholder.classList.add('hidden');
  
  // Clean old elements
  canvas.querySelectorAll('.canvas-element').forEach(el => el.remove());
  
  // Append current elements
  canvasElements.forEach((el, index) => {
    const elDiv = document.createElement('div');
    elDiv.className = `canvas-element group/canvas p-1 relative rounded border-2 border-transparent ${el.id === selectedElementId ? 'selected' : ''}`;
    elDiv.setAttribute('data-id', el.id);
    
    // Stop event bubble to canvas click
    elDiv.onclick = (event) => {
      event.stopPropagation();
      selectElement(el.id);
    };
    
    let childHtml = '';
    
    switch (el.type) {
      case 'header':
        childHtml = `<h2 class="${el.classes}">${escapeHtml(el.text)}</h2>`;
        break;
      case 'button':
        childHtml = `<button class="${el.classes}">${escapeHtml(el.text)}</button>`;
        break;
      case 'input':
        childHtml = `<input type="text" placeholder="${escapeHtml(el.text)}" class="${el.classes}" disabled>`;
        break;
      case 'textarea':
        childHtml = `<textarea placeholder="${escapeHtml(el.text)}" class="${el.classes}" disabled></textarea>`;
        break;
    }
    
    elDiv.innerHTML = `
      ${childHtml}
      <div class="absolute right-2 top-2 bg-slate-900 border border-slate-800 text-slate-500 rounded p-1 hidden group-hover/canvas:flex gap-1 shrink-0 z-20">
        <button onclick="moveElement(${index}, -1); event.stopPropagation();" class="hover:text-white p-0.5" title="Move Up"><i data-lucide="arrow-up" class="w-3.5 h-3.5"></i></button>
        <button onclick="moveElement(${index}, 1); event.stopPropagation();" class="hover:text-white p-0.5" title="Move Down"><i data-lucide="arrow-down" class="w-3.5 h-3.5"></i></button>
        <button onclick="deleteElement('${el.id}'); event.stopPropagation();" class="hover:text-red-400 p-0.5" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>
    `;
    
    canvas.appendChild(elDiv);
  });
  
  if (window.lucide) window.lucide.createIcons();
  
  // Recompile exported code
  compileExportedCode();
}

function selectElement(id) {
  selectedElementId = id;
  
  // Update canvas selection border highlights
  document.querySelectorAll('.canvas-element').forEach(el => {
    if (el.getAttribute('data-id') === id) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
  
  const element = canvasElements.find(el => el.id === id);
  
  const form = document.getElementById('inspector-form');
  const empty = document.getElementById('inspector-empty');
  const indexBadge = document.getElementById('selected-index-badge');
  
  if (!element) {
    selectedElementId = null;
    form.classList.add('hidden');
    empty.classList.remove('hidden');
    indexBadge.textContent = 'None Selected';
    return;
  }
  
  empty.classList.add('hidden');
  form.classList.remove('hidden');
  indexBadge.textContent = element.type.toUpperCase();
  
  // Populate property inputs
  document.getElementById('prop-text').value = element.text;
  document.getElementById('prop-classes').value = element.classes;
  document.getElementById('prop-binding').value = element.binding;
  
  // Conditionally show custom JS triggers
  const triggerContainer = document.getElementById('prop-trigger-container');
  if (element.type === 'button') {
    triggerContainer.classList.remove('hidden');
    document.getElementById('prop-trigger').value = element.trigger || '';
  } else {
    triggerContainer.classList.add('hidden');
  }
}

function updateSelectedElement() {
  if (!selectedElementId) return;
  
  const element = canvasElements.find(el => el.id === selectedElementId);
  if (!element) return;
  
  element.text = document.getElementById('prop-text').value;
  element.classes = document.getElementById('prop-classes').value;
  element.binding = document.getElementById('prop-binding').value;
  
  if (element.type === 'button') {
    element.trigger = document.getElementById('prop-trigger').value;
  }
  
  // Re-render canvas but keep selector active
  const canvas = document.getElementById('designer-canvas');
  const activeDiv = canvas.querySelector(`[data-id="${element.id}"]`);
  
  let childHtml = '';
  switch (element.type) {
    case 'header':
      childHtml = `<h2 class="${element.classes}">${escapeHtml(element.text)}</h2>`;
      break;
    case 'button':
      childHtml = `<button class="${element.classes}">${escapeHtml(element.text)}</button>`;
      break;
    case 'input':
      childHtml = `<input type="text" placeholder="${escapeHtml(element.text)}" class="${element.classes}" disabled>`;
      break;
    case 'textarea':
      childHtml = `<textarea placeholder="${escapeHtml(element.text)}" class="${element.classes}" disabled></textarea>`;
      break;
  }
  
  // Live update target div's child elements directly to prevent complete component rebuild while typing
  if (activeDiv) {
    const buttonsDiv = activeDiv.querySelector('div.absolute');
    activeDiv.innerHTML = `${childHtml}`;
    if (buttonsDiv) activeDiv.appendChild(buttonsDiv);
  }
  
  compileExportedCode();
}

function deleteSelectedElement() {
  if (!selectedElementId) return;
  deleteElement(selectedElementId);
}

function deleteElement(id) {
  canvasElements = canvasElements.filter(el => el.id !== id);
  if (selectedElementId === id) {
    selectedElementId = null;
    selectElement(null);
  }
  renderCanvas();
}

function moveElement(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= canvasElements.length) return;
  
  // Swap elements
  const temp = canvasElements[index];
  canvasElements[index] = canvasElements[targetIndex];
  canvasElements[targetIndex] = temp;
  
  renderCanvas();
}

function clearCanvas() {
  canvasElements = [];
  selectedElementId = null;
  selectElement(null);
  renderCanvas();
}

function loadDefaultTemplate() {
  canvasElements = [
    { 
      id: 'el-1', 
      type: 'header', 
      text: 'Multi-Agent Sandbox Dashboard Interface', 
      classes: 'text-lg font-bold font-outfit text-emerald-400 mb-2 border-b border-slate-800 pb-2 flex items-center gap-2', 
      binding: '', 
      trigger: '' 
    },
    { 
      id: 'el-2', 
      type: 'textarea', 
      text: 'Describe autonomous execution task instructions...', 
      classes: 'w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/10 h-24 mb-3 transition-all', 
      binding: 'task', 
      trigger: '' 
    },
    { 
      id: 'el-3', 
      type: 'input', 
      text: 'Correlation Identification Route Override (UUID)', 
      classes: 'w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-400 mb-3', 
      binding: 'correlation_id', 
      trigger: '' 
    },
    { 
      id: 'el-4', 
      type: 'button', 
      text: 'Submit Task to Gateway Orchestration', 
      classes: 'w-full bg-gradient-to-r from-brand-600 to-emerald-600 hover:from-brand-500 hover:to-emerald-500 text-white font-bold text-xs py-3 rounded-xl transition-all duration-300 active:scale-95 shadow-lg shadow-brand-900/25', 
      binding: '', 
      trigger: 'triggerGatewayExecution()' 
    }
  ];
  selectedElementId = null;
  selectElement(null);
  renderCanvas();
}

function compileExportedCode() {
  const codeBox = document.getElementById('code-output');
  if (canvasElements.length === 0) {
    codeBox.textContent = '<!-- Canvas is empty -->';
    return;
  }
  
  let html = '<!-- Designed components block for Gateway console integration -->\n';
  html += '<div class="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl p-6 flex flex-col gap-3 max-w-xl mx-auto">\n';
  
  canvasElements.forEach(el => {
    const bindAttr = el.binding ? ` data-bind="${el.binding}"` : '';
    const clickAttr = el.trigger ? ` onclick="${el.trigger}"` : '';
    
    switch (el.type) {
      case 'header':
        html += `  <h2 class="${el.classes}"${bindAttr}>${el.text}</h2>\n`;
        break;
      case 'button':
        html += `  <button class="${el.classes}"${clickAttr}>${el.text}</button>\n`;
        break;
      case 'input':
        html += `  <input type="text" placeholder="${el.text}" class="${el.classes}"${bindAttr}>\n`;
        break;
      case 'textarea':
        html += `  <textarea placeholder="${el.text}" class="${el.classes}"${bindAttr}></textarea>\n`;
        break;
    }
  });
  
  html += '</div>';
  codeBox.textContent = html;
}

function copyGeneratedCode() {
  const text = document.getElementById('code-output').textContent;
  navigator.clipboard.writeText(text).then(() => {
    alert("Canvas HTML markup code copied to clipboard successfully!");
  }).catch(err => {
    console.error("Clipboard copy failure:", err);
  });
}

// ----------------------------------------------------
// SYSTEM HELPER UTILITIES
// ----------------------------------------------------
function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatIsoTime(isoString) {
  if (!isoString) return '--';
  try {
    const date = new Date(isoString);
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    return `${hours}:${minutes} ${ampm}`;
  } catch (err) {
    return isoString;
  }
}
