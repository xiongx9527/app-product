"""验证 WS run-task 的 provider 覆盖会真正影响后端路由。"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
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


async def _check_dashscope_voice_mismatch():
    """跨提供商 / 跨模型的音色必须直接报错，不再静默回退默认音色。"""
    tmp = tempfile.mkdtemp(prefix="voice-test-")
    srv.voice_db.configure(os.path.join(tmp, "voice.db"))
    srv.voice_db.ensure_schema()
    try:
        valid = srv._dashscope_voice_ids("cosyvoice-v3-flash")
        assert valid, "本地音色库应有 cosyvoice-v3-flash 音色"
        assert srv._dashscope_default_voice("cosyvoice-v3-flash") in valid

        for bad in ("zh-CN-XiaoxiaoNeural", "longxiang"):
            try:
                await srv._tts_synthesize(
                    "你好。", bad, "1.0", "wav", "dashscope", "ws", "cosyvoice-v3-flash"
                )
            except ValueError as exc:
                assert bad in str(exc), str(exc)
            else:
                raise AssertionError(f"音色 {bad} 不应被 DashScope 接受")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _check_deepseek_voice_mismatch():
    """DeepSeek 音色必须属于其目录：内置 edge 音色 / 非 DeepSeek 音色直接报错。"""
    tmp = tempfile.mkdtemp(prefix="voice-test-")
    srv.voice_db.configure(os.path.join(tmp, "voice.db"))
    srv.voice_db.ensure_schema()
    original = srv.deepseek_tts_bytes
    called = []

    async def fake_ds_tts(text, voice, key):
        called.append(voice)
        return b"ID3fake"

    srv.deepseek_tts_bytes = fake_ds_tts
    try:
        known = sorted(x["id"] for x in srv.voice_db.list_voices("deepseek"))
        assert known, "本地音色库应有 DeepSeek 音色（stella/tide）"

        # 截图场景：选了 DeepSeek，音色却是内置 edge-tts 的 zh-CN-XiaoxiaoNeural → 必须报错
        for bad in ("zh-CN-XiaoxiaoNeural", "longanyang", "not-a-deepseek-voice"):
            try:
                await srv._tts_synthesize(
                    "你好。", bad, "1.0", "wav", "deepseek", "http", "deepseek-tts"
                )
            except ValueError as exc:
                assert bad in str(exc), str(exc)
            else:
                raise AssertionError(f"音色 {bad} 不应被 DeepSeek 接受")

        # 合法音色放行；空音色走该 provider 默认
        await srv._tts_synthesize(
            "你好。", known[0], "1.0", "wav", "deepseek", "http", "deepseek-tts"
        )
        await srv._tts_synthesize(
            "你好。", "", "1.0", "wav", "deepseek", "http", "deepseek-tts"
        )
        assert called[0] == known[0], called
        assert called[1] in known, called
    finally:
        srv.deepseek_tts_bytes = original
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    asyncio.run(_check_tts_provider_override())
    _check_provider_fallback()
    asyncio.run(_check_dashscope_voice_mismatch())
    asyncio.run(_check_deepseek_voice_mismatch())
    print("== SUMMARY: 4/4 provider 与音色校验用例通过 ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
