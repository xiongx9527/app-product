"""真实 httpx 路由回归测试。

三层全真实：真实上游 mock（stdlib HTTP 服务）+ 真实 FastAPI/uvicorn 服务（跑本仓库代码）
+ 真实 httpx 客户端。验证协议翻译、按模型路由到分组、模型目录校验、TTS/STT 路由。

运行方式（需要 Python 3.10+）：
    cd scripts/voice
    python -m venv .venv && . .venv/bin/activate
    pip install "fastapi>=0.115,<1" "uvicorn>=0.34,<1" "python-multipart>=0.0.20,<1" "httpx>=0.27,<1"
    python tests/test_routing_httpx.py

测试默认跑在 TEST_PORT（默认 9511，可用环境变量覆盖）上，不会碰本机正在运行的
9529 服务。结束后输出 [PASS]/[FAIL] 并以退出码 0/1 表示成败。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import threading
import time
from collections import defaultdict

import httpx

# ── 依赖自检：缺包时给出明确安装提示，而不是抛一堆堆栈 ──────────────
try:
    import uvicorn  # noqa: F401
    import fastapi  # noqa: F401
    import multipart  # noqa: F401
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        f"缺少测试依赖：{exc.name}\n"
        "请先：pip install \"fastapi>=0.115,<1\" \"uvicorn>=0.34,<1\" "
        "\"python-multipart>=0.0.20,<1\" \"httpx>=0.27,<1\"\n"
    )
    sys.exit(2)


# ── 配置：端口与临时 HOME ───────────────────────────────────────────
TEST_PORT = int(os.environ.get("TEST_PORT", "9511"))


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


VOICE_HOME = "/tmp/voice_route_test_home"
CONF_PATH = os.path.join(VOICE_HOME, "voice.conf")


import http.server  # noqa: E402
import socketserver  # noqa: E402

# 上游命中记录：label -> [(method, path, body_head)]
HITS: dict[str, list[tuple[str, str, bytes]]] = defaultdict(list)


def _make_handler(label: str, protocol: str):
    class _H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):  # 静默
            pass

        def _record(self, body_head: bytes = b""):
            HITS[label].append((self.command, self.path, body_head[:120]))

        def do_GET(self):
            self._record()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"object":"list","data":[]}')

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            self._record(body)
            self._respond(protocol)

        def _respond(self, proto: str):
            if proto == "openai":
                ct, payload = "text/event-stream", (
                    b'data: {"id":"x","object":"chat.completion.chunk","model":"m",'
                    b'"choices":[{"index":0,"delta":{"content":"openai-reply"}}]}\n\n'
                    b"data: [DONE]\n\n"
                )
            elif proto == "anthropic":
                ct, payload = "text/event-stream", (
                    b"event: message_start\n"
                    b'data: {"type":"message_start","message":{"role":"assistant"}}\n\n'
                    b"event: content_block_delta\n"
                    b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic-reply"}}\n\n'
                    b"event: message_stop\n"
                    b'data: {"type":"message_stop"}\n\n'
                )
            elif proto == "gemini":
                ct, payload = "text/event-stream", (
                    b'data: {"candidates":[{"content":{"parts":[{"text":"gemini-reply"}]}}]}\n\n'
                )
            elif proto == "tts":
                ct, payload = "audio/mpeg", b"\x00\x01fake-mp3"
            elif proto == "stt":
                ct, payload = "application/json", json.dumps(
                    {"text": "stt-ok:" + self.path}
                ).encode()
            else:
                ct, payload = "application/json", b"{}"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return _H


def _start_mock(label: str, protocol: str) -> str:
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _make_handler(label, protocol))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}"


def _write_conf(m: dict[str, str]) -> None:
    os.makedirs(VOICE_HOME, exist_ok=True)
    for f in os.listdir(VOICE_HOME):
        os.remove(os.path.join(VOICE_HOME, f))
    conf = f"""
VOICE_API_KEY=off
VOICE_PORT={TEST_PORT}
LLM_UPSTREAM_POOL={{"openai":{{"model":"gpt-4o-mini","accounts":[{{"base_url":"{m['openai']}/v1","api_key":"k"}}]}},"anthropic":{{"model":"claude-sonnet","accounts":[{{"base_url":"{m['anthropic']}/v1","api_key":"k"}}]}},"gemini":{{"model":"gemini-1.5-pro","accounts":[{{"base_url":"{m['gemini']}","api_key":"k"}}]}}}}
TTS_UPSTREAM_POOL={{"gA":{{"model":"tts-a","accounts":[{{"base_url":"{m['ttsA']}","api_key":"k"}}]}},"gB":{{"model":"tts-b","accounts":[{{"base_url":"{m['ttsB']}","api_key":"k"}}]}}}}
STT_UPSTREAM_POOL={{"gA":{{"model":"stt-a","accounts":[{{"base_url":"{m['sttA']}","api_key":"k"}}]}},"gB":{{"model":"stt-b","accounts":[{{"base_url":"{m['sttB']}","api_key":"k"}}]}}}}
"""
    with open(CONF_PATH, "w") as f:
        f.write(conf)


def _start_server():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, here)
    os.environ["VOICE_HOME"] = VOICE_HOME
    os.environ["VOICE_CONFIG"] = CONF_PATH
    import openai_voice_server as srv  # noqa: F401  (必须在设好 env 后导入)

    t = threading.Thread(target=lambda: srv.main(["--port", str(TEST_PORT)]), daemon=True)
    t.start()
    base = f"http://127.0.0.1:{TEST_PORT}"
    for _ in range(100):
        try:
            if httpx.get(base + "/health", timeout=1).status_code == 200:
                return base
        except Exception:
            time.sleep(0.2)
    raise SystemExit("服务启动失败")


async def _chat(client: httpx.AsyncClient, base: str, model: str):
    async with client.stream(
        "POST", f"{base}/llm/v1/chat/completions",
        json={"model": model, "messages": [{"role": "user", "content": "hi"}], "stream": True},
    ) as r:
        text = ""
        async for line in r.aiter_lines():
            text += line + "\n"
        return r.status_code, text, r.headers


_RESULTS: list[tuple[str, bool]] = []


def _check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


async def _main(base: str) -> None:
    # 1) openai 线协议
    async with httpx.AsyncClient() as c:
        st, txt, hd = await _chat(c, base, "gpt-4o-mini")
    _check("LLM openai 路由+翻译", st == 200 and "openai-reply" in txt, f"status={st}")
    _check("openai 命中 /v1/chat/completions",
           any(p == "/v1/chat/completions" for _, p, _ in HITS["openai"]))

    # 2) anthropic 线协议
    async with httpx.AsyncClient() as c:
        st, txt, hd = await _chat(c, base, "claude-sonnet")
    _check("LLM anthropic 路由+翻译", st == 200 and "anthropic-reply" in txt, f"status={st}")
    _check("anthropic 命中 /v1/messages",
           any(p == "/v1/messages" for _, p, _ in HITS["anthropic"]))

    # 3) gemini 线协议
    async with httpx.AsyncClient() as c:
        st, txt, hd = await _chat(c, base, "gemini-1.5-pro")
    _check("LLM gemini 路由+翻译", st == 200 and "gemini-reply" in txt, f"status={st}")
    _check("gemini 命中 :streamGenerateContent",
           any(":streamGenerateContent" in p for _, p, _ in HITS["gemini"]))

    # 4) 模型目录校验：目录非空时未知模型 -> 400
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{base}/llm/v1/chat/completions",
                         json={"model": "not-a-real-model",
                               "messages": [{"role": "user", "content": "hi"}]})
    _check("LLM 未知模型被 400 拒绝", r.status_code == 400, f"status={r.status_code}")

    # 5) /llm/v1/models 返回分组并集
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{base}/llm/v1/models")
    ids = {d["id"] for d in r.json()["data"]}
    _check("LLM /v1/models 并集",
           {"gpt-4o-mini", "claude-sonnet", "gemini-1.5-pro"} <= ids, f"ids={ids}")

    # 6) TTS 按模型路由到分组
    async with httpx.AsyncClient() as c:
        rA = await c.post(f"{base}/voide/v1/audio/speech",
                          json={"input": "hi", "model": "tts-a", "voice": "alloy"})
        rB = await c.post(f"{base}/voide/v1/audio/speech",
                          json={"input": "hi", "model": "tts-b", "voice": "alloy"})
    _check("TTS tts-a 路由到 gA", rA.status_code == 200
           and any(p.endswith("/audio/speech") for _, p, _ in HITS["ttsA"]), f"status={rA.status_code}")
    _check("TTS tts-b 路由到 gB", rB.status_code == 200
           and any(p.endswith("/audio/speech") for _, p, _ in HITS["ttsB"]), f"status={rB.status_code}")

    # 7) STT 按模型路由到分组
    async with httpx.AsyncClient() as c:
        rA = await c.post(f"{base}/voide/v1/audio/transcriptions",
                          data={"model": "stt-a"},
                          files={"file": ("a.wav", b"RIFFfake", "audio/wav")})
        rB = await c.post(f"{base}/voide/v1/audio/transcriptions",
                          data={"model": "stt-b"},
                          files={"file": ("a.wav", b"RIFFfake", "audio/wav")})
    _check("STT stt-a 路由到 gA", rA.status_code == 200 and "stt-ok" in rA.text,
           f"status={rA.status_code} text={rA.text[:40]}")
    _check("STT stt-b 路由到 gB", rB.status_code == 200 and "stt-ok" in rB.text,
           f"status={rB.status_code} text={rB.text[:40]}")


def main() -> int:
    mocks = {
        "openai": _start_mock("openai", "openai"),
        "anthropic": _start_mock("anthropic", "anthropic"),
        "gemini": _start_mock("gemini", "gemini"),
        "ttsA": _start_mock("ttsA", "tts"),
        "ttsB": _start_mock("ttsB", "tts"),
        "sttA": _start_mock("sttA", "stt"),
        "sttB": _start_mock("sttB", "stt"),
    }
    _write_conf(mocks)
    base = _start_server()
    print(f"== server up @ {base} ==")

    import asyncio

    asyncio.run(_main(base))

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        shutil.rmtree(VOICE_HOME, ignore_errors=True)
    sys.exit(rc)
