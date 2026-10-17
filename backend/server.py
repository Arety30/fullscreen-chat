from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
import json

app = FastAPI()

# Enable CORS for the Firefox extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_BASE = "http://localhost:11434"
N8N_WEBHOOK = "http://localhost:5678/webhook/your-unique-id" # Update with your n8n URL

@app.get("/models")
async def get_models():
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            return resp.json()
        except Exception as e:
            return {"models": []}

@app.post("/chat")
async def chat(data: dict):
    prompt = data.get("prompt", "")
    model = data.get("model", "abrarai:latest")
    
    # 1. Routing Logic for n8n
    if "n8n" in prompt.lower() or "automate" in prompt.lower():
        async with httpx.AsyncClient() as client:
            n8n_resp = await client.post(N8N_WEBHOOK, json={"user_input": prompt})
            return {"response": "Task sent to n8n.", "details": n8n_resp.json()}

    # 2. Routing Logic for OpenManus/LangChain (Placeholder)
    if "code" in prompt.lower() or "search" in prompt.lower():
        # Insert your OpenManus logic here
        return {"response": "Agentic task initiated...", "status": "processing"}

    # 3. Default: Direct to Ollama
    async with httpx.AsyncClient() as client:
        payload = {"model": model, "prompt": prompt, "stream": False}
        resp = await client.post(f"{OLLAMA_BASE}/api/generate", json=payload)
        return {"response": resp.json().get("response", "No response from model")}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
