#!/usr/bin/env python3
"""音色 / ASR-TTS 模型目录的初始化脚本（把 seed/*.json 灌进 voice.db）。

为什么单独一个脚本：
    目录数据（音色、ASR/TTS 模型 + 提供商 + 协议）属于「随版本走的静态资产」，
    不应该写死在业务代码里。数据放 `seed/*.json`，本脚本负责建表 + 幂等灌库，
    部署 / 换机 / 升级时跑一次即可；服务启动时的首次播种也走同一份数据。

用法：
    python3 scripts/voice/init_catalog.py                 # 补齐缺失项（幂等，不动已有数据）
    python3 scripts/voice/init_catalog.py --force         # 用种子覆盖已有项（改描述/协议后同步）
    python3 scripts/voice/init_catalog.py --reset         # 先删该提供商的目录再灌（彻底重建）
    python3 scripts/voice/init_catalog.py --provider deepseek
    python3 scripts/voice/init_catalog.py --db /tmp/voice.db --dry-run --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import catalog  # noqa: E402
import voice_db  # noqa: E402


def default_db_path() -> str:
    """与服务启动时的路径解析保持一致：VOICE_DB_DIR 或 ~/.app-product/voice。"""
    db_dir = os.environ.get("VOICE_DB_DIR")
    if not db_dir:
        if os.name == "nt":
            base = os.environ.get("LOCALAPPDATA") or os.path.join(
                os.path.expanduser("~"), "AppData", "Local"
            )
            db_dir = os.path.join(base, "app-product", "voice")
        else:
            db_dir = os.path.join(os.path.expanduser("~"), ".app-product", "voice")
    return os.path.join(os.path.expanduser(db_dir), "voice.db")


def main() -> int:
    ap = argparse.ArgumentParser(description="初始化音色 / ASR-TTS 模型目录")
    ap.add_argument("--db", default=None, help="voice.db 路径（默认 $VOICE_DB_DIR/voice.db）")
    ap.add_argument("--provider", default=None, help="只处理某个提供商（builtin/dashscope/deepseek）")
    ap.add_argument("--force", action="store_true", help="用种子覆盖已有条目")
    ap.add_argument("--reset", action="store_true", help="先删除该提供商的目录再灌")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写库")
    ap.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    args = ap.parse_args()

    prov = (args.provider or "").strip().lower() or None
    db_path = os.path.abspath(os.path.expanduser(args.db or default_db_path()))

    voice_rows = catalog.load_voices(prov)
    model_rows = catalog.load_speech_models(prov)
    if not voice_rows and not model_rows:
        msg = f"种子目录里没有匹配的条目（provider={prov or '全部'}）"
        print(msg if not args.json else json.dumps({"ok": False, "message": msg}, ensure_ascii=False))
        return 1

    if args.dry_run:
        summary = {
            "ok": True,
            "dry_run": True,
            "db": db_path,
            "provider": prov or "all",
            "voices": len(voice_rows),
            "models": len(model_rows),
        }
        print(json.dumps(summary, ensure_ascii=False) if args.json else
              f"[dry-run] {db_path}：将写入 {len(voice_rows)} 个音色、{len(model_rows)} 个模型")
        return 0

    voice_db.configure(db_path)
    # 关掉建表时的自动播种：本脚本自己灌库并统计，避免「实际是建表播的、脚本报 0 新增」。
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()

    providers = sorted({r["provider"] for r in voice_rows + model_rows})
    removed = 0
    if args.reset:
        for p in providers:
            removed += voice_db.delete_voices_by_provider(p)
            removed += voice_db.delete_speech_models_by_provider(p)

    have_voices = {r["id"] for r in voice_db.list_voices()}
    have_models = {
        (r["kind"], r["provider"], r["model"]): (r.get("protocol") or "")
        for r in voice_db.list_speech_models()
    }

    v_new = v_upd = 0
    for r in voice_rows:
        exists = r["id"] in have_voices
        if exists and not args.force:
            continue
        voice_db.upsert_voice(
            r["id"], r["provider"], r["model"],
            desc_zh=r["desc_zh"], desc_en=r["desc_en"],
            sort=r["sort"], is_default=r["is_default"],
        )
        v_upd += 1 if exists else 0
        v_new += 0 if exists else 1

    m_new = m_upd = 0
    for r in model_rows:
        key = (r["kind"], r["provider"], r["model"])
        exists = key in have_models
        if exists and not args.force:
            # protocol 是随版本走的目录元数据（不是用户在页面上选的），seed 改了就同步；
            # 默认模型 / 排序是用户选择，绝不覆盖。这样改 seed 后跑一次脚本即可升级口径。
            if r["protocol"] and have_models[key] != r["protocol"]:
                voice_db.set_speech_model_protocol(*key, r["protocol"])
                m_upd += 1
            continue
        voice_db.upsert_speech_model(
            r["kind"], r["provider"], r["model"],
            protocol=r["protocol"], is_default=r["is_default"], sort=r["sort"],
        )
        m_upd += 1 if exists else 0
        m_new += 0 if exists else 1

    summary = {
        "ok": True,
        "db": db_path,
        "provider": prov or "all",
        "removed": removed,
        "voices": {"new": v_new, "updated": v_upd},
        "models": {"new": m_new, "updated": m_upd},
        "totals": voice_db.stats(),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"数据库：{db_path}")
        print(f"提供商：{', '.join(providers)}" + (f"（删除 {removed} 条）" if removed else ""))
        print(f"音色：新增 {v_new}，更新 {v_upd}")
        print(f"模型：新增 {m_new}，更新 {m_upd}")
        print(f"当前库内：{summary['totals']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
