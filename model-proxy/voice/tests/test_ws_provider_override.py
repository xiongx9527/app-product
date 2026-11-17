"""验证 WS run-task 的 provider 覆盖会真正影响后端路由。"""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import openai_voice_server as srv  # noqa: E402


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(text)

    async def send_bytes(self, data):
        self.sent.append(data)


async def _check_tts_provider_override():
    """全局仍是 builtin 时，run-task.provider=dashscope 必须让 TTS 走上游。"""
    calls = []
    steps = iter((
        {"header": {"action": "continue-task"}, "payload": {"input": {"text": "你好。"}}},
        {"header": {"action": "finish-task"}},
    ))

    async def fake_receive(_ws, _task_id=None, _timeout=None):
        return {
            "type": "websocket.receive",
            "bytes": None,
            "text": json.dumps(next(steps)),
        }

    async def fake_synthesize(text, voice, rate, fmt, provider, protocol, model, speed=1.0):
        calls.append((provider, protocol, model, voice))
        return b"RIFFfake", "audio/wav"

    original_receive = srv._ws_receive
    original_synthesize = srv._tts_synthesize
    original_provider = os.environ.get("TTS_PROVIDER")
    srv._ws_receive = fake_receive
    srv._tts_synthesize = fake_synthesize
    os.environ["TTS_PROVIDER"] = "builtin"
    try:
        ok = await srv._ws_handle_tts(
            FakeWebSocket(), "t1", "cosyvoice-v3-flash",
            {"provider": "DashScope ", "parameters": {"voice": "longanyang"}},
        )
    finally:
        srv._ws_receive = original_receive
        srv._tts_synthesize = original_synthesize
        if original_provider is None:
            os.environ.pop("TTS_PROVIDER", None)
        else:
            os.environ["TTS_PROVIDER"] = original_provider

    assert ok, "WS TTS 子流程应成功"
    assert calls == [("dashscope", "ws", "cosyvoice-v3-flash", "longanyang")], calls


def _check_provider_fallback():
    original = os.environ.get("STT_PROVIDER")
    os.environ["STT_PROVIDER"] = "builtin"
    try:
        assert srv._ws_task_provider({}, "STT_PROVIDER") == "builtin"
        assert srv._ws_task_provider({"provider": " DashScope "}, "STT_PROVIDER") == "dashscope"
    finally:
        if original is None:
            os.environ.pop("STT_PROVIDER", None)
        else:
            os.environ["STT_PROVIDER"] = original


def main():
    asyncio.run(_check_tts_provider_override())
    _check_provider_fallback()
    print("== SUMMARY: 2/2 provider 覆盖用例通过 ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
