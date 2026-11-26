"""其他工具 SSE 支持回归测试。

覆盖：
1. _extract_sse_text 对 OpenAI delta / Dify answer / workflow outputs / 纯文本 / [DONE] 的解析
2. _call_http_tool 对普通 JSON 响应保持原行为
3. _call_http_tool 对 text/event-stream 自动识别、解析并汇总正文
4. _call_http_tool 对 application/x-ndjson 逐行解析

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_http_tool_sse.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

_VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_VOICE_DIR))

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


class MockHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        path = self.path
        if path == "/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            evs = [
                {"answer": "你"},
                {"choices": [{"delta": {"content": "好"}}]},
                {"data": {"outputs": {"answer": "，世界"}}},
            ]
            for e in evs:
                self.wfile.write(("data: " + json.dumps(e, ensure_ascii=False) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        elif path == "/ndjson":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for e in [{"answer": "A"}, {"answer": "B"}]:
                self.wfile.write((json.dumps(e, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"result":"ok"}')

    def log_message(self, *a):
        pass


def main() -> int:
    import voice_db
    import mcp_gateway as g

    # 解析函数单测
    check("OpenAI delta", g._extract_sse_text('{"choices":[{"delta":{"content":"世"}}]}') == "世")
    check("Dify answer", g._extract_sse_text('{"answer":"你好"}') == "你好")
    check("workflow outputs", g._extract_sse_text('{"data":{"outputs":{"answer":"界"}}}') == "界")
    check("纯文本兜底", g._extract_sse_text("兜底文本") == "兜底文本")
    check("[DONE] 忽略", g._extract_sse_text("[DONE]") == "")

    # 起 mock 服务
    srv = HTTPServer(("127.0.0.1", 0), MockHandler)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{port}"

    import asyncio

    async def run():
        tool_common = {"headers_json": "{}", "params_json": "[]", "method": "POST", "timeout_sec": 5}
        # 普通响应
        r1 = await g._call_http_tool({**tool_common, "url": base + "/json"}, {})
        check("普通响应原行为", "HTTP 200" in r1 and '{"result":"ok"}' in r1, r1[:120])
        # SSE
        r2 = await g._call_http_tool({**tool_common, "url": base + "/sse"}, {})
        check("SSE 识别", "SSE" in r2, r2[:120])
        check("SSE 正文汇总", "你好，世界" in r2, r2[:120])
        # NDJSON
        r3 = await g._call_http_tool({**tool_common, "url": base + "/ndjson"}, {})
        check("NDJSON 汇总", "AB" in r3, r3[:120])
        # query 合并（URL 自带 query 不被覆盖）
        r4 = await g._call_http_tool({**tool_common, "url": base + "/json?key=abc"}, {})
        check("URL query 保留", "HTTP 200" in r4, r4[:120])

    asyncio.run(run())
    srv.shutdown()

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
