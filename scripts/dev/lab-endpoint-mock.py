#!/usr/bin/env python3
"""Minimal OpenAI-compatible chat server used to verify the 'lab endpoint'
(custom provider) path end to end without real lab hardware.

Run:  python scripts/dev/lab-endpoint-mock.py   (serves on 127.0.0.1:8123)
Endpoints: GET /v1/models, POST /v1/chat/completions (non-streaming).
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8123
MODEL = "mock-lab-v1"


def answer(question: str) -> str:
    q = (question or "").strip()
    m = re.search(r"(\d+)\s*\+\s*(\d+)", q)
    if m:
        return f"{int(m.group(1)) + int(m.group(2))}"
    if "hello" in q.lower():
        return "Hello from mock-lab-v1."
    return f"mock-lab-v1 received: {q[:200]}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "mock"}]})
        else:
            self._send(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"error": {"message": "bad json", "type": "invalid_request_error"}})
            return
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        msgs = payload.get("messages", [])
        question = "\n".join((m.get("content") or "") for m in msgs if isinstance(m, dict))
        text = answer(question)
        self._send(200, {
            "id": "mock-chat-1",
            "object": "chat.completion",
            "created": 0,
            "model": payload.get("model", MODEL),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": len(question), "completion_tokens": len(text), "total_tokens": len(question) + len(text)},
        })


if __name__ == "__main__":
    print(f"mock OpenAI-compatible lab endpoint on http://{HOST}:{PORT} (model {MODEL})", file=sys.stderr)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
