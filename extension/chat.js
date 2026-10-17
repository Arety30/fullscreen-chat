async function fetchModels() {
    const res = await fetch("http://localhost:8000/models");
    const data = await res.json();
    const select = document.getElementById("model-select");
    data.models.forEach(m => {
        let opt = document.createElement("option");
        opt.value = m.name;
        opt.innerHTML = m.name;
        select.appendChild(opt);
    });
}

async function sendMessage() {
    const input = document.getElementById("user-input");
    const model = document.getElementById("model-select").value;
    const chat = document.getElementById("chat-window");
    
    chat.innerHTML += `<p><b>You:</b> ${input.value}</p>`;
    
    const res = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input.value, model: model })
    });
    const data = await res.json();
    chat.innerHTML += `<p><b>AI:</b> ${data.response}</p>`;
    input.value = "";
}

fetchModels();
