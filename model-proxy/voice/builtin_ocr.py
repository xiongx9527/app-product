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

_DIR = os.path.dirname(os.path.abspath(__file__))
_TIMEOUT = int(os.environ.get("OCR_TIMEOUT", "120"))
# onnxruntime/rapidocr 独立安装目录：Dockerfile 默认装到 /opt/ocr-libs；
# 旧容器可用 OCR_LIB_DIR 覆盖（如挂载卷里的可写目录 /data/.pylibs）。
_LIBS = os.environ.get("OCR_LIB_DIR", "/opt/ocr-libs").strip()
# 引擎：paddle（默认，需 AVX2）| rapidocr（onnxruntime，CPU 要求低，Docker 用）
_ENGINE = (os.environ.get("OCR_ENGINE", "paddle") or "paddle").strip().lower()


def _worker_path() -> str:
    name = "ocr_worker_ort.py" if _ENGINE == "rapidocr" else "ocr_worker.py"
    return os.path.join(_DIR, name)


def ready() -> bool:
    """worker 脚本与依赖是否就位（不实际跑模型）。

    注意：绝不能在此 import rapidocr 或改主进程 sys.path——rapidocr 依赖 numpy2，
    而主进程的重排(sklearn/scipy)是 numpy1.x 编译的，混用会让重排崩溃。
    只检查文件是否存在，真正的 import 放到子进程里（PYTHONPATH 注入）。
    """
    if not os.path.isfile(_worker_path()):
        return False
    if _ENGINE == "rapidocr":
        # 只检查依赖目录存在，不 import、不改 sys.path
        return bool(_LIBS and os.path.isdir(os.path.join(_LIBS, "rapidocr_onnxruntime")))
    try:
        import paddleocr  # noqa: F401
        return True
    except ImportError:
        return False


def model_name() -> str:
    # 面板表格保存落 OCR_BUILTIN_MODEL；兼容旧 OCR_MODEL_VERSION 环境变量
    return os.environ.get("OCR_BUILTIN_MODEL") or os.environ.get("OCR_MODEL_VERSION") or "PP-OCRv5"


def recognize(image_bytes: bytes, max_pages: int = 20) -> dict[str, Any]:
    """识别图片或 PDF 文字（worker 按魔数自动判断类型，调用方无需指定）。

    图片返回 {ok,kind:"image",texts,full_text}；
    PDF 返回 {ok,kind:"pdf",page_count,pages:[{page,texts,full_text}],texts,full_text}。
    """
    if not image_bytes:
        raise ValueError("图片内容为空")
    worker = _worker_path()
    if not os.path.isfile(worker):
        raise RuntimeError(f"OCR worker 不存在：{worker}")
    # stdin 传 base64（纯文本，避免二进制在管道里被截断/编码问题）
    import base64

    payload = json.dumps({"image": base64.b64encode(image_bytes).decode("ascii"), "max_pages": max_pages})
    # 子进程环境变量：可写依赖目录注入 PYTHONPATH；抑制 onnxruntime 遥测日志污染 stdout。
    env = os.environ.copy()
    if _LIBS:
        env["PYTHONPATH"] = _LIBS + os.pathsep + env.get("PYTHONPATH", "")
    env["ORT_DISABLE_TELEMETRY"] = "1"
    proc = subprocess.run(
        [sys.executable, worker],
        input=payload.encode("utf-8"),
        capture_output=True,
        timeout=_TIMEOUT,
        env=env,
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
