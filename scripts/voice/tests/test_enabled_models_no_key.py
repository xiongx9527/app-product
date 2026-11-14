"""无 API Key 时「勾选模型仍能保存进启用表」的回归测试。

背景（真实缺陷）：
    管理面板把默认提供商切到 DashScope / DeepSeek 但没填 API Key 时，
    saveProvConfig() 里的 hasProvKey() 校验会提前 return，整次 POST 都不发，
    用户勾好的模型清单完全丢失（ASR / TTS 两个 tab 都中招）。
    另有几处会让勾选丢失：两个槽的写入带条件、只发 cands.filter(sel) 漏项、
    默认模型写空串导致 config_kv 与启用表不一致。

运行（无需起 9529 服务，用临时 SQLite）：
    cd scripts/voice
    .venv/bin/python tests/test_enabled_models_no_key.py

锁住的关键点：
1. 后端：POST /admin/api/config 只带勾选清单、不带任何 API Key，也要把模型
   按 (kind, provider) 整体写进 enabled_speech_models，且基础库 speech_models
   一行都不能被改动（两张表严格分离）。
2. 后端：STT_PROVIDER=dashscope / deepseek 且无 Key 时同样写入。
3. 后端：取消到 "[]" 时启用表对应分组被清空，不影响别的分组。
4. 后端：默认模型随勾选一起落 is_default，且 config_kv 的 *_MODEL 不为空串。
5. 前端：saveProvConfig 里不存在「没 Key 就 return」的提前阻断，且两个槽
   无条件写 *_MODELS / *_DEEPSEEK_MODELS。
"""
from __future__ import annotations

import json
import os
import re
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
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import admin_panel
    import config_store
    import voice_db

    tmpdir = tempfile.mkdtemp(prefix="voice_enabled_test_")
    db_path = os.path.join(tmpdir, "voice.db")

    # 用临时库建 store；关掉自动播种，避免 seed 数据干扰「基础库不变」的断言
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    config_store.configure(db_path, None, None)

    # 手工建会话，绕过登录表单（测试只关心已登录后的保存链路）
    token = "test-session-token"
    voice_db.session_create(token, "admin")

    app = FastAPI()
    admin_panel.register_admin_routes(app)
    client = TestClient(app)
    client.cookies.set(admin_panel.SESSION_COOKIE, token, path="/admin")

    # config_store.configure() 会 ensure_schema() 并按 seed 播种基础库全量
    # （16 条）。这里取它的快照，用来断言「保存动作一行都不改基础库」。
    base_before = {(r["kind"], r["provider"], r["model"], r["protocol"])
                   for r in voice_db.list_speech_models()}
    check("前置: 基础库已由 seed 播种", len(base_before) > 0,
          f"models={len(base_before)}")

    def save(patch: dict) -> dict:
        r = client.post("/admin/api/config", json=patch)
        assert r.status_code == 200, f"POST 失败: {r.status_code} {r.text}"
        return r.json()

    # ── 1) 无 Key、默认提供商 deepseek：ASR 勾选必须写进启用表 ──────────
    save({
        "STT_PROVIDER": "deepseek",                      # 切到无 Key 的上游
        "STT_UPSTREAM_MODELS": json.dumps(["paraformer-realtime-v2", "paraformer-v2"]),
        "STT_UPSTREAM_MODEL": "paraformer-v2",
        "STT_DEEPSEEK_MODELS": json.dumps(["deepseek-asr"]),
        "STT_DEEPSEEK_MODEL": "deepseek-asr",
        # 故意不带任何 *_API_KEY
    })
    stt_ds = voice_db.enabled_models("stt", "dashscope")
    check("无Key(deepseek): dashscope 勾选写入启用表",
          stt_ds == ["paraformer-realtime-v2", "paraformer-v2"], f"got={stt_ds}")
    stt_dk = voice_db.enabled_models("stt", "deepseek")
    check("无Key(deepseek): deepseek 勾选写入启用表",
          stt_dk == ["deepseek-asr"], f"got={stt_dk}")
    check("无Key(deepseek): 默认模型标 is_default",
          voice_db.enabled_default_model("stt", "dashscope") == "paraformer-v2",
          f"got={voice_db.enabled_default_model('stt','dashscope')}")
    base_after = {(r["kind"], r["provider"], r["model"], r["protocol"])
                  for r in voice_db.list_speech_models()}
    check("基础库 speech_models 未被保存动作改动", base_before == base_after,
          f"before={len(base_before)} after={len(base_after)}")

    # ── 2) 换 dashscope 为默认提供商、仍无 Key ─────────────────────────
    save({
        "STT_PROVIDER": "dashscope",
        "STT_UPSTREAM_MODELS": json.dumps(["paraformer-realtime-v2"]),
        "STT_UPSTREAM_MODEL": "paraformer-realtime-v2",
        "STT_DEEPSEEK_MODELS": json.dumps([]),   # 取消全部 deepseek 勾选
        "STT_DEEPSEEK_MODEL": "",
    })
    check("无Key(dashscope): 勾选仍写入",
          voice_db.enabled_models("stt", "dashscope") == ["paraformer-realtime-v2"])
    check("取消到[]: deepseek 分组被清空",
          voice_db.enabled_models("stt", "deepseek") == [],
          f"got={voice_db.enabled_models('stt','deepseek')}")

    # ── 3) TTS 无 Key 同样写入，且不影响 ASR 分组 ───────────────────────
    save({
        "TTS_PROVIDER": "dashscope",
        "TTS_UPSTREAM_MODELS": json.dumps(["cosyvoice-v3-flash"]),
        "TTS_UPSTREAM_MODEL": "cosyvoice-v3-flash",
        "TTS_DEEPSEEK_MODELS": json.dumps([]),
        "TTS_DEEPSEEK_MODEL": "",
    })
    check("无Key: TTS 勾选写入启用表",
          voice_db.enabled_models("tts", "dashscope") == ["cosyvoice-v3-flash"])
    check("TTS 保存不影响 ASR 分组",
          voice_db.enabled_models("stt", "dashscope") == ["paraformer-realtime-v2"])

    # ── 4) config_kv 的默认模型不为空串（前端 defOf 回退的落库结果）─────
    cfg = voice_db.load_config()
    check("config_kv STT_UPSTREAM_MODEL 非空", bool(cfg.get("STT_UPSTREAM_MODEL")),
          f"got={cfg.get('STT_UPSTREAM_MODEL')!r}")

    # ── 5) 前端源码：不得再有「没 Key 就 return」的提前阻断 ─────────────
    src = (_VOICE_DIR / "admin_panel.py").read_text(encoding="utf-8")
    body = src[src.index("async function saveProvConfig"):src.index("function saveSttTable")]
    # hasProvKey 只能用于拼提示文案，不能出现在 return 语句里
    blocking = [ln.strip() for ln in body.splitlines()
                if "hasProvKey" in ln and "return" in ln]
    check("前端: 无 Key 不再 return 阻断保存", not blocking, f"found={blocking}")
    # keyWarn 只用于拼成功后的状态文案，不得参与任何 return / 提前退出
    check("前端: keyWarn 只作状态提示、保存请求照样发出",
          "let keyWarn = ''" in body
          and "keyWarn ? ' · ' + keyWarn : ''" in body
          and "keyWarn" not in "".join(
              ln for ln in body.splitlines() if "return" in ln))
    # 两个槽都无条件写 *_MODELS（不能带 cands.length 之类的门槛）
    check("前端: dashscope 槽无条件写 *_UPSTREAM_MODELS",
          bool(re.search(r"patch\[cap \+ '_UPSTREAM_MODELS'\]", body)) and
          "if (Array.isArray(e.cands))" not in body)
    check("前端: deepseek 槽无条件写 *_DEEPSEEK_MODELS",
          "if (Array.isArray(dsk.cands) && dsk.cands.length)" not in body)
    check("前端: 有勾选就回退默认模型 defOf", "const defOf" in body)
    check("前端: picked 以 sel 为准(不只用 cands.filter)", "const pickedOf" in body)

    # ── 6) 默认视图只显示已启用的模型，↻ 才展开全量 ───────────────────
    # 加载回填：候选只取「已启用」(enModels)，不再把基础库全量当候选。
    check("前端: 默认视图候选只取已启用(enModels)，不展全量",
          "e.cands = enModels.length ? [...new Set(enModels)] : [...new Set(base)];" in src
          and "[...new Set([...base, ...en.map(x=>x.model)])]" not in src)
    # ↻ 刷新处理器仍把候选展开为基础库全量（rows），保留勾选/默认用于增删。
    check("前端: ↻ 刷新仍展开基础库全量候选",
          "e.cands = rows.map(x => x.model)" in src)

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
