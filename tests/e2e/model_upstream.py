import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import time


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def record(self, filename, value):
        with (Path(os.environ["E2E_ARTIFACT_DIR"]) / filename).open("a") as output:
            output.write(json.dumps(value) + "\n")

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"deterministic-model-upstream"}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        messages = body.get("messages", [])
        prompt = next((item.get("content", "") for item in reversed(messages) if item.get("role") == "user"), "")
        if not isinstance(prompt, str):
            prompt = json.dumps(prompt)
        tools = [item.get("function", {}).get("name", "") for item in body.get("tools", [])]
        results = [item.get("content", "") for item in messages if item.get("role") == "tool"]
        self.record("model-requests.jsonl", {"path": self.path, "stream": body.get("stream"), "prompt": prompt, "tool_names": tools, "tool_results": results})
        if "E2E_ERROR" in prompt:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"E2E controlled model error","type":"invalid_request_error","code":"e2e_error"}}')
            return
        if "E2E_STALL" in prompt:
            time.sleep(8)
        text = "REAL_E2E_RESPONSE: " + prompt
        if results:
            text = "REAL_E2E_TOOL_RESULT: " + str(results[-1])
        if not body.get("stream"):
            response = {"id": "e2e-completion", "object": "chat.completion", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(delta, finish=None):
            chunk = {"id": "e2e-stream", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()

        try:
            emit({"role": "assistant"})
            if "E2E_TOOL" in prompt and not results:
                tool = next(name for name in tools if "e2e_add" in name)
                emit({"tool_calls": [{"index": 0, "id": "call_e2e_add", "type": "function", "function": {"name": tool, "arguments": ""}}]})
                emit({"tool_calls": [{"index": 0, "function": None}]})
                emit({"tool_calls": [{"index": 0, "function": {"arguments": '{"a":2,"b":3}'}}]})
                emit({}, "tool_calls")
            else:
                if "E2E_REASONING" in prompt:
                    emit({"reasoning_content": "E2E deterministic reasoning"})
                pieces = [text[:19], text[19:]]
                if "E2E_CANCEL" in prompt:
                    pieces = [f"E2E slow token {index} " for index in range(100)]
                for piece in pieces:
                    time.sleep(0.1 if "E2E_CANCEL" not in prompt else 0.25)
                    emit({"content": piece})
                emit({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.record("model-disconnects.jsonl", {"prompt": prompt, "disconnected": True})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 20057), ModelHandler).serve_forever()
