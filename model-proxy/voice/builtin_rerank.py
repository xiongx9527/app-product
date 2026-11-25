"""内置重排（rerank）引擎：用 sentence-transformers CrossEncoder 本地加载 bge-reranker 等模型。

非 Docker、复用语音服务的 venv；懒加载（首次调用才加载模型），失败不影响服务启动。
供 openai_voice_server 的 /v1/rerank 在 protocol=builtin 时调用。
"""
from __future__ import annotations

import os
import threading
from typing import Any

_model = None
_model_path = None
_lock = threading.Lock()

# 默认模型目录候选（与 install-rerank.sh 一致）
_CANDIDATES = [
    os.environ.get("RERANK_MODEL", ""),
    # 容器里 VOICE_HOME=/data，模型挂在 /data/models 下；优先于固定 ~ 路径。
    os.path.join(os.environ.get("VOICE_HOME", ""), "models", "bge-reranker-v2-m3")
    if os.environ.get("VOICE_HOME") else "",
    os.path.expanduser("~/Workspace/Soft/models/bge-reranker-v2-m3"),
    os.path.expanduser("~/.app-product/voice/models/bge-reranker-v2-m3"),
]


def _resolve_path() -> str:
    for p in _CANDIDATES:
        if p and os.path.isfile(os.path.join(p, "config.json")):
            return p
    raise RuntimeError(
        "未找到本地重排模型：请下载 BAAI/bge-reranker-v2-m3 到 "
        "~/.app-product/voice/models/ 或设 RERANK_MODEL 指向模型目录"
    )


def get_model():
    """懒加载 CrossEncoder（线程安全，单例）。"""
    global _model, _model_path
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            from sentence_transformers import CrossEncoder
        except ImportError:
            raise RuntimeError("缺少 sentence-transformers：请运行 ./model-proxy/install-rerank.sh")
        path = _resolve_path()
        _model = CrossEncoder(path)
        _model_path = path
        return _model


def model_name() -> str:
    return os.path.basename(_model_path or "") or "builtin-reranker"


def score(query: str, documents: list[str], batch_size: int = 32) -> list[float]:
    """对 documents 按与 query 的相关性打分，返回与输入等长的分数列表（0~1 附近）。"""
    if not documents:
        return []
    model = get_model()
    pairs = [(query, str(d)) for d in documents]
    scores = model.predict(pairs, batch_size=batch_size, convert_to_numpy=True)
    return [float(s) for s in scores]


def to_cohere(query: str, documents: list[str], scores: list[float],
              top_n: int | None = None, return_documents: bool = False,
              model: str | None = None) -> dict[str, Any]:
    """把内置打分结果转成入站 Cohere 风格响应（按分数降序）。"""
    results = [
        {"index": i, "relevance_score": round(s, 6), **({"document": str(documents[i])} if return_documents else {})}
        for i, s in enumerate(scores)
    ]
    results.sort(key=lambda x: x["relevance_score"], reverse=True)
    if top_n and top_n > 0:
        results = results[:top_n]
    out: dict[str, Any] = {"results": results, "model": model or model_name(), "usage": {}}
    return out
