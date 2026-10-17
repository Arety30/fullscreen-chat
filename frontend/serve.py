import json
import os
import sys
import glob
import uuid
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, HTTPServer
from pathlib import Path

# Add project root to sys.path to enable loading state manager directly
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.append(str(PROJECT_ROOT))

# Global server-level execution tracker
latest_run_status = {
    "active": False,
    "correlation_id": None,
    "request_id": None,
    "intent": None
}

class DesignerConsoleHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for the local developer dashboard
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/logs':
            self.handle_api_logs()
        elif self.path == '/api/sessions':
            self.handle_api_sessions()
        elif self.path.startswith('/api/sessions/'):
            session_id = self.path.split('/')[-1]
            self.handle_api_session_detail(session_id)
        elif self.path == '/api/status':
            self.handle_api_status()
        else:
            # Fallback to standard static file serving from current directory
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/execute':
            self.handle_api_execute()
        else:
            self.send_error_response(404, "Endpoint not found")

    # ----------------------------------------------------
    # API HANDLERS
    # ----------------------------------------------------
    def handle_api_logs(self):
        logs_dir = PROJECT_ROOT / "OpenManus" / "logs"
        log_files = glob.glob(str(logs_dir / "*.log"))
        
        # Check workspace root log files too as a fallback
        fallback_files = glob.glob(str(PROJECT_ROOT / "openmanus_task_*.log"))
        all_files = log_files + fallback_files
        
        lines = []
        if all_files:
            latest_file = max(all_files, key=os.path.getmtime)
            try:
                with open(latest_file, 'r', encoding='utf-8', errors='replace') as f:
                    lines = [line.rstrip('\n') for line in f.readlines()]
            except Exception as e:
                lines = [f"Error reading log file {latest_file}: {str(e)}"]
        else:
            lines = []
            
        self.send_json_response({"lines": lines})

    def handle_api_sessions(self):
        state_dir = PROJECT_ROOT / "memory" / "state"
        session_files = glob.glob(str(state_dir / "*.json"))
        
        sessions_data = []
        for file_path in session_files:
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                # Extract excerpt of latest message
                last_msg = "Empty context"
                history = data.get("history", [])
                if history:
                    last_msg = history[-1].get("content", "")
                    if len(last_msg) > 30:
                        last_msg = last_msg[:27] + "..."
                        
                sessions_data.append({
                    "session_id": data.get("session_id", Path(file_path).stem),
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                    "estimated_tokens": data.get("estimated_tokens", 0),
                    "last_message_excerpt": last_msg
                })
            except Exception as e:
                print(f"Error parsing session file {file_path}: {e}")
                
        # Sort by updated_at descending
        sessions_data.sort(key=lambda s: s.get("updated_at", ""), reverse=True)
        self.send_json_response(sessions_data)

    def handle_api_session_detail(self, session_id):
        # Sanitize session_id to prevent path traversal
        clean_id = "".join(ch for ch in session_id if ch.isalnum() or ch in ("-", "_", "."))
        file_path = PROJECT_ROOT / "memory" / "state" / f"{clean_id}.json"
        
        if file_path.exists():
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self.send_json_response(data)
            except Exception as e:
                self.send_error_response(500, f"Error reading session: {str(e)}")
        else:
            self.send_error_response(404, "Session not found")

    def handle_api_status(self):
        gateway_status = "offline"
        latest_session_id = "--"
        latest_request_id = "--"
        latest_intent = "idle"
        n8n_info = "n8n trigger offline"
        
        # Test FastAPI health
        try:
            req = urllib.request.Request("http://127.0.0.1:8000/health", method="GET")
            with urllib.request.urlopen(req, timeout=1.0) as res:
                if res.status == 200:
                    gateway_status = "healthy"
        except Exception:
            pass
            
        # Inspect recent session files to extract latest execution status
        state_dir = PROJECT_ROOT / "memory" / "state"
        session_files = glob.glob(str(state_dir / "*.json"))
        if session_files:
            latest_file = max(session_files, key=os.path.getmtime)
            try:
                with open(latest_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                latest_session_id = data.get("session_id", "--")
                latest_request_id = f"req-{latest_session_id[:8]}"
                
                # Get the last event to check current intent activity
                history = data.get("history", [])
                if history:
                    last_event = history[-1]
                    latest_intent = last_event.get("metadata", {}).get("intent", "shell_autonomous")
                    n8n_info = "n8n webhook triggers active"
            except Exception:
                pass
                
        # If server-level execution occurred recently, override default state
        global latest_run_status
        if latest_run_status.get("active", False):
            latest_session_id = latest_run_status.get("correlation_id", latest_session_id)
            latest_request_id = latest_run_status.get("request_id", latest_request_id)
            latest_intent = latest_run_status.get("intent", latest_intent)
            n8n_info = "Interactive console trigger active"
            
        self.send_json_response({
            "gateway": gateway_status,
            "correlation_id": latest_session_id,
            "request_id": latest_request_id,
            "intent": latest_intent,
            "n8n_info": n8n_info
        })

    def handle_api_execute(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        payload = json.loads(post_data.decode('utf-8'))
        task = payload.get("task", "")
        
        # Keep track of active run in server state
        global latest_run_status
        correlation_id = str(uuid.uuid4())
        request_id = f"local-{uuid.uuid4()}"
        latest_run_status = {
            "active": True,
            "correlation_id": correlation_id,
            "request_id": request_id,
            "intent": "shell_autonomous" if any(hint in task.lower() for hint in ("run", "execute", "install", "openmanus", "shell")) else "chat_only"
        }
        
        # Forward to the local FastAPI Gateway Orchestrator running on port 8000
        url = "http://127.0.0.1:8000/v1/execute"
        headers = {"Content-Type": "application/json"}
        forward_payload = {
            "user_prompt": task,
            "prompt": task,
            "task": task,
            "correlation_id": correlation_id,
            "request_id": request_id
        }
        
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(forward_payload).encode('utf-8'),
                headers=headers,
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=30.0) as res:
                response_data = json.loads(res.read().decode('utf-8'))
                
            latest_run_status["active"] = False
            self.send_json_response(response_data)
        except Exception as e:
            print(f"FastAPI orchestrator connection failed: {e}. Attempting direct import fallback execution...")
            try:
                import asyncio
                from orchestrator import AgentOrchestrator
                
                # Setup asyncio loop and execute synchronously inside HTTP handler thread
                orchestrator = AgentOrchestrator()
                
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result = loop.run_until_complete(orchestrator.route_task(task, raw_payload=forward_payload))
                loop.close()
                
                response_data = {
                    "ok": result.status == "success",
                    "request_id": result.request_id,
                    "correlation_id": result.correlation_id,
                    "intent": result.decision.destination,
                    "output": result.output,
                    "message": "Direct import execution complete."
                }
                latest_run_status["active"] = False
                self.send_json_response(response_data)
            except Exception as inner_err:
                print(f"Direct import execution fallback failed: {inner_err}")
                latest_run_status["active"] = False
                self.send_error_response(500, f"Failed to execute task: {str(e)} (fallback error: {str(inner_err)})")

    # ----------------------------------------------------
    # HTTP HELPER RESPONSE METHODS
    # ----------------------------------------------------
    def send_json_response(self, data):
        response_bytes = json.dumps(data).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def send_error_response(self, code, message):
        response_bytes = json.dumps({"error": message}).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

def run_server(port=8050):
    # Navigate to the serving directory (frontend/)
    os.chdir(Path(__file__).resolve().parent)
    
    server_address = ('', port)
    httpd = HTTPServer(server_address, DesignerConsoleHandler)
    print(f"Abrar AI - Designer & Console Dashboard Server online at http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard server.")
        httpd.server_close()

if __name__ == '__main__':
    run_server()
