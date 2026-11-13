"""端到端验证 /voice/ws/inference 的 ASR/TTS 成功与异常路径。"""
import asyncio
import base64
import json
import os

import websockets

URL = os.environ.get("WS_URL", "ws://127.0.0.1:9529/voice/ws/inference")
TIMEOUT = 8.0


async def _recv_actions(ws, n=1):
    out = []
    for _ in range(n):
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=TIMEOUT)
        except asyncio.TimeoutError:
            out.append("(超时无响应)")
            break
        if isinstance(raw, bytes):
            out.append(f"(二进制 {len(raw)} 字节)")
        else:
            d = json.loads(raw)
            act = (d.get("header") or {}).get("action")
            if act == "task-failed":
                out.append(f"task-failed: {d['header'].get('error_message')}")
            else:
                out.append(act)
    return out


def _run_task(task_id, task, model=""):
    return json.dumps({
        "header": {"action": "run-task", "task_id": task_id},
        "payload": {"task": task, "model": model},
    })


def _finish(task_id):
    return json.dumps({"header": {"action": "finish-task", "task_id": task_id}})


def _continue(task_id, text):
    return json.dumps({
        "header": {"action": "continue-task", "task_id": task_id},
        "payload": {"input": {"text": text}},
    })


def _load_sample_wav():
    with open(os.path.join(os.path.dirname(__file__), "..", "asr_sample.b64"), "rb") as f:
        return base64.b64decode(f.read())


async def test_asr_success():
    wav = _load_sample_wav()
    async with websockets.connect(URL) as ws:
        await ws.send(_run_task("s1", "asr"))
        print("=== 真实 WAV ASR 成功 ===")
        print("  run-task:", (await _recv_actions(ws, 1))[0])
        await ws.send(wav)
        await ws.send(_finish("s1"))
        res = await _recv_actions(ws, 2)
        print("  结果:", res)
        await ws.close()


async def test_tts_success():
    async with websockets.connect(URL) as ws:
        await ws.send(_run_task("s2", "tts"))
        print("\n=== 内置 TTS 成功(返回二进制音频) ===")
        print("  run-task:", (await _recv_actions(ws, 1))[0])
        await ws.send(_continue("s2", "你好，这是语音合成测试。"))
        await ws.send(_finish("s2"))
        res = await _recv_actions(ws, 2)
        print("  结果:", res)
        await ws.close()


async def test_asr_bad_audio():
    async with websockets.connect(URL) as ws:
        await ws.send(_run_task("t1", "asr"))
        print("=== 坏音频(not-wav) -> task-failed ===")
        print("  run-task:", (await _recv_actions(ws, 1))[0])
        await ws.send(b"not-wav")  # 裸二进制，非 WAV
        await ws.send(_finish("t1"))
        print("  结果:", (await _recv_actions(ws, 1))[0])
        # 连接应仍可复用
        await ws.send(_run_task("t2", "asr"))
        print("  复用 run-task:", (await _recv_actions(ws, 1))[0])
        await ws.close()


async def test_asr_empty():
    async with websockets.connect(URL) as ws:
        await ws.send(_run_task("e1", "asr"))
        print("\n=== 空音频(无二进制) -> task-failed ===")
        print("  run-task:", (await _recv_actions(ws, 1))[0])
        await ws.send(_finish("e1"))
        print("  结果:", (await _recv_actions(ws, 1))[0])
        await ws.close()


async def test_isolated_finish():
    async with websockets.connect(URL) as ws:
        print("\n=== 孤立 finish-task -> task-failed(可接受) ===")
        await ws.send(_finish("x1"))
        print("  结果:", (await _recv_actions(ws, 1))[0])
        await ws.close()


async def test_unknown_task():
    async with websockets.connect(URL) as ws:
        print("\n=== 未知 task -> task-failed 不断连 ===")
        await ws.send(_run_task("u1", "unknown"))
        print("  结果:", (await _recv_actions(ws, 1))[0])
        await ws.close()


async def test_builtin_mismatch():
    # 内置模式下传上游（ws）模型属于「模型与提供商对不上」，应回清晰 task-failed 而非静默。
    async with websockets.connect(URL) as ws:
        print("\n=== 内置模式传上游 ws 模型 -> 清晰 task-failed ===")
        await ws.send(_run_task("m1", "asr", "cosyvoice-v2"))
        print("  run-task:", (await _recv_actions(ws, 1))[0])
        print("  结果:", (await _recv_actions(ws, 1))[0])
        # TTS 同理（独立 run-task，避免上一条提前返回后残留帧干扰）
        await ws.send(_run_task("m2", "tts", "cosyvoice-v2"))
        print("  tts run-task:", (await _recv_actions(ws, 1))[0])
        print("  tts 结果:", (await _recv_actions(ws, 1))[0])
        await ws.close()


async def main():
    for fn in (test_asr_success, test_tts_success, test_asr_bad_audio,
               test_asr_empty, test_isolated_finish, test_unknown_task,
               test_builtin_mismatch):
        try:
            await fn()
        except Exception as e:  # noqa: BLE001
            print(f"  [异常] {type(e).__name__}: {e}")


if __name__ == "__main__":
    asyncio.run(main())
