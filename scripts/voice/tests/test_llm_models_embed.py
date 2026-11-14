"""`/llm/v1/models` 必须返回向量（embeddings）模型（type=EMBED）。

背景（真实缺陷）：
    llm_catalog() 只遍历 LLM 池并硬编码 type=LLM，导致 EMBED 上游池里的向量模型
    不出现在 /llm/v1/models，测试界面 / 网关看不到可用向量模型。
    修复后 EMBED 池的模型单独标 type=EMBED 并入列表；同时 llm_catalog() 仍只含
    LLM 类型，避免对话校验的 validate()（find 搜全部类型）误把向量模型当对话模型放行。

运行（无需起 9529 服务，用临时 SQLite）：
    cd scripts/voice
    .venv/bin/python tests/test_llm_models_embed.py

锁住的关键点：
1. embed_catalog() 只返回 EMBED 类型、且含 EMBED 池里的向量模型，不含 LLM 类型。
2. llm_catalog() 仍只返回 LLM 类型、含 LLM 池模型，不含 EMBED 类型（校验不被污染）。
3. GET /llm/v1/models 同时返回两类：向量模型 type=EMBED，对话模型 type=LLM。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

_VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_VOICE_DIR))

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


def main() -> int:
    import config_store
    import model_catalog
    import openai_voice_server as srv
    import upstream_pool
    import voice_db

    tmpdir = tempfile.mkdtemp(prefix="llm_models_embed_")
    db = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    config_store.configure(db, None, None)

    # 写 LLM 池与 EMBED（向量）池，再让 config_store / 池缓存读到最新值
    voice_db.set_config(
        "LLM_UPSTREAM_POOL",
        json.dumps([
            {"vendor": "ollama", "protocol": "openai_chat_completions",
             "model": "deepseek-r1:1.5b", "base_url": "http://127.0.0.1:11434", "api_key": "sk-x"}
        ]),
    )
    voice_db.set_config(
        "EMBED_UPSTREAM_POOL",
        json.dumps([
            {"vendor": "ollama", "protocol": "openai_chat_completions",
             "model": "nomic-embed-text:latest", "base_url": "http://127.0.0.1:11434", "api_key": ""}
        ]),
    )
    # 默认模型按提供商维度（与 default_model_for_provider 口径一致）
    voice_db.set_config(
        "LLM_UPSTREAM_DEFAULT_MODELS",
        json.dumps({"ollama": "deepseek-r1:1.5b"}),
    )
    voice_db.set_config(
        "EMBED_UPSTREAM_DEFAULT_MODELS",
        json.dumps({"ollama": "nomic-embed-text:latest"}),
    )
    upstream_pool._pool_cache.clear()

    # ── 1) embed_catalog：只含 EMBED 类型，且含向量模型，默认标记正确 ──
    emb = srv.embed_catalog()
    emb_ids = [m.id for m in emb]
    check("embed_catalog 返回向量模型 nomic-embed-text:latest",
          "nomic-embed-text:latest" in emb_ids, f"ids={emb_ids}")
    check("embed_catalog 类型全为 EMBED",
          all(m.type == model_catalog.ModelType.EMBED for m in emb), f"types={[m.type for m in emb]}")
    check("embed_catalog 不含 LLM 类型",
          not any(m.type == model_catalog.ModelType.LLM for m in emb))
    emb_def = {m.id: m.is_default for m in emb}
    check("embed_catalog 默认标记正确(ollama 默认=nomic-embed-text:latest)",
          emb_def.get("nomic-embed-text:latest") is True, f"def={emb_def}")

    # ── 2) llm_catalog：仍只含 LLM 类型（校验不被污染），默认标记正确 ──
    llm = srv.llm_catalog()
    llm_ids = [m.id for m in llm]
    check("llm_catalog 含 LLM 模型 deepseek-r1:1.5b",
          "deepseek-r1:1.5b" in llm_ids, f"ids={llm_ids}")
    check("llm_catalog 只含 LLM 类型",
          all(m.type == model_catalog.ModelType.LLM for m in llm))
    check("llm_catalog 不含 EMBED 类型",
          not any(m.type == model_catalog.ModelType.EMBED for m in llm))
    llm_def = {m.id: m.is_default for m in llm}
    check("llm_catalog 默认标记正确(ollama 默认=deepseek-r1:1.5b)",
          llm_def.get("deepseek-r1:1.5b") is True, f"def={llm_def}")

    # ── 3) GET /llm/v1/models 接口同时返回两类 ──
    resp = asyncio.run(srv.llm_models())
    # llm_models 可能返回普通 dict（正常）或 JSONResponse（禁用态），统一转 dict
    if hasattr(resp, "body"):
        import io as _io
        body = resp.body
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8")
        data = json.loads(body).get("data", [])
    else:
        data = resp.get("data", [])
    id_type = {m["id"]: m.get("type") for m in data}
    id_def = {m["id"]: m.get("is_default") for m in data}
    check("接口 200 且返回 data 列表", isinstance(data, list) and len(data) >= 2, f"n={len(data)}")
    check("接口返回向量模型 type=EMBED",
          id_type.get("nomic-embed-text:latest") == model_catalog.ModelType.EMBED, f"got={id_type}")
    check("接口返回对话模型 type=LLM",
          id_type.get("deepseek-r1:1.5b") == model_catalog.ModelType.LLM)
    check("接口：向量模型 is_default=True",
          id_def.get("nomic-embed-text:latest") is True, f"def={id_def}")
    check("接口：LLM 默认模型 is_default=True",
          id_def.get("deepseek-r1:1.5b") is True, f"def={id_def}")

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
