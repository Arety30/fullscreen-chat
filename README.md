# Full-Screen Chat

Full-Screen Chat is a set of four small pieces by Syed Abrar Ali that together give a local language model a proper browser tab instead of a cramped popup: a Firefox extension whose toolbar button opens a full-page chat view, a FastAPI backend that lists the models on a local Ollama server and routes prompts (to Ollama, to an n8n automation webhook, or to an agent hook), a developer dashboard served by a plain Python HTTP server for inspecting agent sessions and logs, and a `memory` package that keeps per-session conversation state within a 4,000-token budget and summarises bulky terminal output with a local model. It solves two problems at once: chatting with local models from the browser with zero cloud dependency, and keeping an agent's context small enough for a 4k-context model.

## Where it is used

On Abrar's laptop the extension is the everyday way to talk to local Ollama models in Firefox. The `frontend/` dashboard is the operator console he opens while an agent orchestrator (a separate project that lives in the parent directory of this repository) runs shell tasks: it shows the latest log file, every saved session, and lets him fire a task at the orchestrator. The `memory` package is the shared library both the orchestrator and the dashboard read session files from.

## How it works

### `backend/server.py` — chat API (port 8000)

| Endpoint | Behaviour |
|----------|-----------|
| `GET /models` | Proxies Ollama `GET /api/tags`; returns `{"models": []}` on error |
| `POST /chat` `{prompt, model}` | Routing by keyword: if the prompt contains "n8n" or "automate" it POSTs `{user_input}` to `N8N_WEBHOOK` and returns its reply; if it contains "code" or "search" it returns a placeholder "Agentic task initiated..." (hook for an agent runner, not implemented); otherwise it calls Ollama `/api/generate` with `stream: false` and returns `{"response": ...}`. Default model is `abrarai:latest` |

CORS is open (`*`) so the extension page can call it. `OLLAMA_BASE` and `N8N_WEBHOOK` are constants at the top of the file.

### `extension/` — Firefox extension

- `manifest.json`: Manifest V3, permission `tabs`, a toolbar action and a background script.
- `background.js`: on action click, `browser.tabs.create({url: "chat.html"})`.
- `chat.html` / `chat.js`: a sidebar with a `<select>` filled from `http://localhost:8000/models`, a chat window and an input. `sendMessage()` POSTs `{prompt, model}` to `/chat` and appends "You:" and "AI:" lines.

### `frontend/` — dashboard (port 8050)

`serve.py` subclasses `SimpleHTTPRequestHandler`: static files come from `frontend/`, and a handful of JSON routes are implemented by hand. `PROJECT_ROOT` is the parent of `frontend/`, i.e. the repository root.

| Route | Source of data |
|-------|----------------|
| `GET /api/logs` | Newest `*.log` under `PROJECT_ROOT/OpenManus/logs/` or `PROJECT_ROOT/openmanus_task_*.log`, returned as lines |
| `GET /api/sessions` | Every `memory/state/*.json`: id, timestamps, estimated tokens, last-message excerpt, newest first |
| `GET /api/sessions/<id>` | Full session JSON (id is sanitised to alphanumerics, `-`, `_`, `.`) |
| `GET /api/status` | Probes `http://127.0.0.1:8000/health` for a gateway, reads the newest session's last `metadata.intent`, and overlays the in-process "latest run" record |
| `POST /api/execute` `{task}` | Builds correlation/request ids, guesses intent (`shell_autonomous` if the task mentions run/execute/install/shell, else `chat_only`), forwards to `http://127.0.0.1:8000/v1/execute`; if that fails it tries `from orchestrator import AgentOrchestrator` from the project root and runs `route_task()` in a fresh event loop |

`index.html` + `app.js` (Tailwind CDN, Lucide icons) has two tabs:

- **Console**: session list with filter, gateway status badge, correlation/request/intent stats, a terminal pane polling `/api/logs` every 1.5 s (`/api/status` every 2 s), a task input that calls `/api/execute`, and a session detail pane rendering `summaries` and `history`.
- **Designer**: a small UI builder; add `button`, `input`, `textarea`, `header` elements to a canvas, edit text / data-binding / Tailwind classes / click trigger in an inspector, reorder or delete, and copy the generated HTML from the code pane.

### `memory/` — session state

- `StateManager` (dataclass) writes one JSON file per session under `MEMORY_STATE_DIR` (default `memory/state`). Files are written atomically (temp file + `os.replace`).
- `estimate_tokens()` = `max(word_count, len(text)//4)`, a cheap guard for a 4,096-token model. The default budget is 4,000 tokens minus a 96-token reserve.
- `append_event(session_id, role, content, metadata, summarize_if_large)` adds a turn; if `summarize_if_large` and the content is >= 2,400 estimated tokens it is replaced by `summarize_terminal_output()` first.
- `trim_context()` pops the oldest history entries into `summaries` as 280-char "Condensed prior ... entry" records, merges the two oldest summaries when still over budget, then truncates the oldest summary and, as a last resort, the newest history entry.
- `summarizer.summarize_terminal_output()` sends the last 12,000 chars to Ollama `/api/generate` (`OLLAMA_BASE_URL`, model `OLLAMA_SUMMARY_MODEL`, default `qwen2.5-coder:1.5b`, `num_ctx` 4096) asking for exactly two sentences, normalises the reply to two sentences, and falls back to a heuristic (first line + the last line containing error/exception/traceback/failed/fatal) when Ollama is unreachable.
- `memory/state/default.json` is a sample session file produced by an earlier run.

## Setup

Requirements: Python 3.10+ (the memory package uses `dataclass(slots=True)` and `X | Y` type unions), Firefox, a local Ollama server with at least one model pulled. Optional: an n8n instance for the webhook route.

```bash
git clone <repo-url> ~/fullscreen-chat
cd ~/fullscreen-chat
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn httpx     # backend/requirements.txt is empty; these are the imports
```

Configuration:

| Setting | Where | Default |
|---------|-------|---------|
| Ollama URL for chat | `OLLAMA_BASE` constant in `backend/server.py` | `http://localhost:11434` |
| n8n webhook | `N8N_WEBHOOK` constant in `backend/server.py` | `http://localhost:5678/webhook/your-unique-id` (replace) |
| Session directory | env `MEMORY_STATE_DIR` | `memory/state` |
| Summariser Ollama URL | env `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| Summariser model | env `OLLAMA_SUMMARY_MODEL` | `qwen2.5-coder:1.5b` |
| Dashboard port | `run_server(port=8050)` in `frontend/serve.py` | 8050 |

## Usage

```bash
# 1. chat backend
python3 backend/server.py                   # 0.0.0.0:8000

# 2. load the extension in Firefox
#    about:debugging -> This Firefox -> Load Temporary Add-on -> extension/manifest.json
#    click the toolbar button -> a full tab opens, pick a model, chat

# 3. operator dashboard
python3 frontend/serve.py                   # http://localhost:8050
```

Using the memory package from Python:

```python
from memory.state_manager import StateManager
sm = StateManager(storage_dir="memory/state")
sm.append_event("demo", "user", "run the tests")
sm.append_event("demo", "system", open("pytest.log").read(), summarize_if_large=True)
print(sm.token_count(sm.load_state("demo")))
```

## Project structure

```
fullscreen-chat/
├── backend/
│   ├── server.py            # FastAPI: /models, /chat routing
│   └── requirements.txt     # (empty)
├── extension/
│   ├── manifest.json        # MV3, opens chat.html in a tab
│   ├── background.js
│   ├── chat.html
│   └── chat.js
├── frontend/
│   ├── serve.py             # static server + /api/* for the dashboard
│   ├── index.html           # Console + Designer tabs
│   ├── app.js
│   └── index.css
└── memory/
    ├── __init__.py
    ├── state_manager.py     # StateManager, token estimate, trimming
    ├── summarizer.py        # two-sentence Ollama summary with fallback
    └── state/
        └── default.json     # sample session
```

## Limitations and notes

- The dashboard expects a gateway on port 8000 exposing `/health` and `/v1/execute`, and an `orchestrator.py` module in the repository root. Neither is in this repository; `backend/server.py` only serves `/models` and `/chat`, so the console's Execute button and the "Gateway" badge stay offline until that orchestrator is present. Sessions, logs and the Designer tab work regardless.
- `/api/logs` looks for an `OpenManus/logs/` directory next to this repo; without it the terminal pane is empty.
- The extension and backend hard-code `localhost:8000`; CORS is wide open and there is no authentication.
- The "code"/"search" branch of `/chat` is a stub.
- `chat.js` inserts model output with `innerHTML`, so the page trusts whatever the model returns.
- Token counts are estimates, not tokenizer output.
