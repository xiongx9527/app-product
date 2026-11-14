"""音色 / ASR-TTS 模型目录的种子数据加载。

数据本体放在 `seed/*.json`（可直接编辑、可被 `init_catalog.py` 重新灌库），
本模块只负责读取与规范化，不含业务逻辑，也不碰数据库。
"""

from __future__ import annotations

import json
import os
from typing import Any

SEED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed")

VOICE_FILES = ("voices_builtin.json", "voices_dashscope.json", "voices_deepseek.json")
MODEL_FILE = "speech_models.json"


def _read_json(name: str) -> Any:
    path = os.path.join(SEED_DIR, name)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_voices(provider: str | None = None) -> list[dict[str, Any]]:
    """读全部 voices_*.json，展平成 voices 表的行（provider 过滤可选）。

    每行：{id, provider, model, desc_zh, desc_en, sort, is_default}
    """
    rows: list[dict[str, Any]] = []
    for name in VOICE_FILES:
        spec = _read_json(name)
        prov = (spec.get("provider") or "").strip()
        if not prov:
            continue
        if provider and prov != provider:
            continue
        model = (spec.get("model") or "").strip()
        default_id = (spec.get("default") or "").strip()
        for i, v in enumerate(spec.get("voices") or []):
            vid = (v.get("id") or "").strip()
            if not vid:
                continue
            rows.append({
                "id": vid,
                "provider": prov,
                "model": model,
                "desc_zh": (v.get("desc_zh") or "").strip(),
                "desc_en": (v.get("desc_en") or "").strip(),
                "sort": i if prov == "builtin" else 1000 + i,
                "is_default": bool(default_id and vid == default_id),
            })
    return rows


def load_speech_models(provider: str | None = None) -> list[dict[str, Any]]:
    """读 speech_models.json，返回模型目录行（provider 过滤可选）。

    每行：{kind, provider, protocol, model, is_default, sort}
    """
    rows: list[dict[str, Any]] = []
    for m in _read_json(MODEL_FILE):
        prov = (m.get("provider") or "").strip()
        kind = (m.get("kind") or "").strip().lower()
        model = (m.get("model") or "").strip()
        if not prov or kind not in ("stt", "tts") or not model:
            continue
        if provider and prov != provider:
            continue
        rows.append({
            "kind": kind,
            "provider": prov,
            "protocol": (m.get("protocol") or "").strip(),
            "model": model,
            "is_default": bool(m.get("default")),
            "sort": int(m.get("sort") or 0),
        })
    return rows


def providers() -> list[str]:
    """种子里出现过的全部提供商（按首次出现顺序去重）。"""
    seen: list[str] = []
    for row in load_voices() + load_speech_models():
        if row["provider"] not in seen:
            seen.append(row["provider"])
    return seen
