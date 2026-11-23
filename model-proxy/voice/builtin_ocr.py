"""内置 OCR 调度：用独立 Python 子进程跑 PaddleOCR，通过 stdin/stdout 通信（不开端口）。

为什么子进程：torch2.2（内置重排）与 paddle3.0 的 C++ 扩展无法同进程共存，
同进程调用 OCR 会 segfault（实测）。子进程隔离后主服务进程只做调度，稳定。
为什么不开端口：用户要求单端口 19529，故用 stdin(base64) → stdout(JSON) 而非 HTTP。

子进程用同一 venv 的 python（numpy 锁 1.26.4 与 torch 共存没问题，只是不能同时 import 调用）。
每次请求起一个短生命周期进程（PaddleOCR 模型加载约 1-2s，可接受）；高频场景可后续加常驻进程池。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr_worker.py")
_TIMEOUT = int(os.environ.get("OCR_TIMEOUT", "120"))


def ready() -> bool:
    """worker 脚本与依赖是否就位（不实际跑模型）。"""
    if not os.path.isfile(_WORKER):
        return False
    try:
        import paddleocr  # noqa: F401
        return True
    except ImportError:
        return False


def model_name() -> str:
    return os.environ.get("OCR_MODEL_VERSION", "PP-OCRv5")


def recognize(image_bytes: bytes) -> dict[str, Any]:
    """识别图片文字。起独立子进程跑 PaddleOCR，返回 {ok,texts,full_text}。"""
    if not image_bytes:
        raise ValueError("图片内容为空")
    if not os.path.isfile(_WORKER):
        raise RuntimeError(f"OCR worker 不存在：{_WORKER}")
    # stdin 传 base64（纯文本，避免二进制在管道里被截断/编码问题）
    import base64

    payload = json.dumps({"image": base64.b64encode(image_bytes).decode("ascii")})
    proc = subprocess.run(
        [sys.executable, _WORKER],
        input=payload.encode("utf-8"),
        capture_output=True,
        timeout=_TIMEOUT,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"OCR 子进程失败（code {proc.returncode}）：{detail}")
    try:
        result = json.loads(proc.stdout.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"OCR 子进程返回非法结果：{exc}")
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "OCR 识别失败")
    return result
