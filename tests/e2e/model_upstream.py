import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import time


# 数据库中触发分隔符兼容问题的技术正文，保留原始字符用于回归。
BELLMAN_CONTENT = (
    "贝尔曼方程的数学公式根据具体场景略有不同，最核心的是**最优贝尔曼方程**（用于寻找最优决策）：\n"
    "\n"
    "对于**状态价值函数** \\(V\\)：\n"
    "\\[\n"
    "V^*(s) = \\max_a \\sum_{s', r} p(s', r \\mid s, a) \\Big[ r + \\gamma V^*(s') \\Big]\n"
    "\\]\n"
    "\n"
    "其中各符号含义：\n"
    "- \\(s\\)：当前状态  \n"
    "- \\(a\\)：当前选择的动作  \n"
    "- \\(s'\\)：下一状态  \n"
    "- \\(r\\)：即时奖励  \n"
    "- \\(p(s', r \\mid s, a)\\)：在状态 \\(s\\) 执行动作 \\(a\\) 后，转移到状态 \\(s'\\) 并获得奖励 \\(r\\) 的概率  \n"
    "- \\(\\gamma\\)：折扣因子，取值范围 \\(0 \\le \\gamma \\le 1\\)，表示未来奖励的重要性  \n"
    "- \\(V^*(s)\\)：从状态 \\(s\\) 出发，按照最优策略能获得的长期期望回报  \n"
    "- \\(\\max_a\\)：在所有可能的动作中，选择使括号内期望值最大的那个动作\n"
    "\n"
    "---\n"
    "\n"
    "如果是给定某个策略 \\(\\pi\\)（不一定是最大，而是按策略行动），则有**贝尔曼期望方程**：\n"
    "\\[\n"
    "V^\\pi(s) = \\sum_a \\pi(a \\mid s) \\sum_{s', r} p(s', r \\mid s, a) \\Big[ r + \\gamma V^\\pi(s') \\Big]\n"
    "\\]\n"
    "\n"
    "此外，还有基于**动作价值函数** \\(Q\\) 的最优贝尔曼方程：\n"
    "\\[\n"
    "Q^*(s, a) = \\sum_{s', r} p(s', r \\mid s, a) \\Big[ r + \\gamma \\max_{a'} Q^*(s', a') \\Big]\n"
    "\\]\n"
    "\n"
    "这个公式表示：在状态 \\(s\\) 采取动作 \\(a\\)，获得即时奖励 \\(r\\)，然后转移到 \\(s'\\)，之后按照最优策略继续行动，最终得到的总期望回报。\n"
    "\n"
    "---\n"
    "\n"
    "**与之前简单版本的关系**  \n"
    "之前提到的  \n"
    "\\[\n"
    "V(\\text{当前状态}) = \\max \\big[ \\text{当前奖励} + \\gamma \\times V(\\text{下一个状态}) \\big]\n"
    "\\]  \n"
    "正是最优贝尔曼方程的**简化思路**。数学公式中加了概率求和，是因为现实中转移和奖励往往具有随机性，需要用期望来精确描述。"
)

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
            if "E2E_MATH_DELIMITERS_EXACT" in prompt:
                for offset in range(0, len(BELLMAN_CONTENT), 73):
                    emit({"content": BELLMAN_CONTENT[offset:offset + 73]})
                    time.sleep(0.05)
                emit({}, "stop")
            elif "E2E_MATH_DELIMITERS_STREAM" in prompt:
                # 将分隔符本身拆片，兼顾残缺内容与后续代码围栏的位置判断。
                for delta, delay in [
                    ({"reasoning_content": "DELIMITER_REASONING \\"}, 0.4),
                    ({"reasoning_content": "(\\frac{3}{"}, 2),
                    ({"reasoning_content": "4}\\"}, 0.4),
                    ({"reasoning_content": ")"}, 0.4),
                    ({"content": "DELIMITER_ANSWER\n\nInline \\"}, 0.4),
                    ({"content": "(V^*(s)\\)"}, 0.4),
                    ({"content": "\n\n\\["}, 0.4),
                    ({"content": "\n\\frac{1}{"}, 2),
                    ({"content": "2}\n\\"}, 0.4),
                    ({"content": "]\n\nCode: `\\(code\\)` and `\\[block\\]`.\n\nOrdinary (V) and [V].\n\n[Link](https://example.com/)\n\n```html\n<p>\\(literal\\) \\[literal\\] $literal$</p>\n"}, 2),
                    ({"content": "`"}, 0.4),
                    ({"content": "`"}, 0.4),
                    ({"content": "`\n\nDELIMITER_CODE_CLOSED"}, 2),
                    ({"content": "\n\nDELIMITER_DONE"}, 0.4),
                ]:
                    emit(delta)
                    time.sleep(delay)
                emit({}, "stop")
            elif "E2E_MATH" in prompt:
                # 延长残缺公式阶段，让浏览器能验证真实 SSE 中间态及后续恢复。
                emit({"reasoning_content": "MATH_REASONING\n\n$$\n\\frac{3}{"})
                time.sleep(2)
                emit({"reasoning_content": "4}\n$$\n"})
                time.sleep(0.5)
                emit({"content": "MATH_ANSWER\n\n$$\n\\frac{1}{"})
                time.sleep(2)
                emit({"content": "2}\n$$\n\nInline $x^2$.\n\n"})
                time.sleep(0.25)
                long_formula = " + ".join(f"x_{{{index}}}" for index in range(60))
                emit({"content": (
                    "Matrix:\n\n$$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n$$\n\n"
                    "Long block:\n\n$$\n" + long_formula + "\n$$\n\n"
                    "Long inline: $\\frac{" + long_formula + "}{1}$\n\n"
                    "Code: `$literal$`\n\n```js\nconst formula = '$x$';\n```\n\n"
                    "Currency: \\$5 and \\$10.\n\n"
                    "Invalid: $\\frac{1}{$\n\n"
                    "Untrusted: $\\href{javascript:alert(1)}{unsafe}$ "
                    "$\\includegraphics{https://invalid.example/math.png}$\n\n"
                    "MATH_DONE"
                )})
                emit({}, "stop")
            elif "E2E_TOOL" in prompt and not results:
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
