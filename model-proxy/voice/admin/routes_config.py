"""管理面板路由 · 配置 / 纠错词 / 同步 / schema / 状态域。

由 admin_panel.register_admin_routes 在运行时加载，共享辅助从主模块按需取。
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

import config_store
import upstream_pool
import voice_db
import voice_correction_store
import admin_panel as ap  # 共享辅助/状态；调用时根模块已完全加载


# 概览缓存：监控类数据，短 TTL 即可，避免高频刷新/多人查看时反复采样 psutil + 连库查询。
# 2 秒内重复请求直接返回缓存，过期后重算；锁防止并发惊群。
_OVERVIEW_TTL = 2.0
_overview_cache: dict[str, Any] = {"at": 0.0, "data": None}
_overview_lock = threading.Lock()
_overview_stats: dict[str, int] = {"hit": 0, "miss": 0}


def _cached_overview() -> tuple[dict[str, Any], bool]:
    """返回 (数据, 是否命中缓存)；命中率可用 overview_cache_stats() 读取。"""
    now = time.monotonic()
    cached = _overview_cache
    if cached["data"] is not None and (now - cached["at"]) < _OVERVIEW_TTL:
        _overview_stats["hit"] += 1
        return cached["data"], True
    with _overview_lock:
        now = time.monotonic()
        if _overview_cache["data"] is not None and (now - _overview_cache["at"]) < _OVERVIEW_TTL:
            _overview_stats["hit"] += 1
            return _overview_cache["data"], True  # 双检：等锁期间可能已被别的线程刷新
        data = ap._system_overview()
        _overview_cache["at"] = now
        _overview_cache["data"] = data
        _overview_stats["miss"] += 1
        return data, False


def overview_cache_stats() -> dict[str, Any]:
    """概览缓存命中率统计（供诊断/管理页展示）。"""
    h, m = _overview_stats["hit"], _overview_stats["miss"]
    return {"hit": h, "miss": m,
            "hit_rate": round(100.0 * h / (h + m), 1) if (h + m) else 0.0,
            "ttl_sec": _OVERVIEW_TTL}


def reset_overview_cache_stats() -> dict[str, Any]:
    """重置命中率计数（管理操作），并让当前缓存失效以便重新采样。"""
    with _overview_lock:
        _overview_stats["hit"] = 0
        _overview_stats["miss"] = 0
        _overview_cache["at"] = 0.0
        _overview_cache["data"] = None
    return overview_cache_stats()


def build_router() -> APIRouter:
    """创建「配置与数据」域的 router。"""
    router = APIRouter()
    require_admin = ap.require_admin
    require_viewer = ap.require_viewer
    HIDDEN = ap.HIDDEN
    voice_status = ap.voice_status
    _system_overview = ap._system_overview
    read_voice_config_masked = ap.read_voice_config_masked
    normalize_tts_voice_on_provider_change = ap.normalize_tts_voice_on_provider_change
    write_voice_config = ap.write_voice_config
    voice_logs = ap.voice_logs
    list_log_files = ap.list_log_files
    voice_action = ap.voice_action
    _validate_hotword = ap._validate_hotword

    @router.get("/admin/api/status", dependencies=[Depends(require_viewer)])
    def admin_status():
        return voice_status()

    @router.get("/admin/api/overview", dependencies=[Depends(require_viewer)])
    def admin_overview():
        data, hit = _cached_overview()
        resp = Response(
            content=json.dumps(data, ensure_ascii=False),
            media_type="application/json",
        )
        resp.headers["X-Overview-Cache"] = "HIT" if hit else "MISS"
        return resp

    @router.get("/admin/api/overview-cache-stats", dependencies=[Depends(require_viewer)])
    def admin_overview_cache_stats():
        return overview_cache_stats()

    @router.post("/admin/api/overview-cache-stats/reset", dependencies=[Depends(require_admin)])
    def admin_overview_cache_stats_reset():
        return reset_overview_cache_stats()

    @router.get("/admin/api/config", dependencies=[Depends(require_admin)])
    def admin_config():
        return read_voice_config_masked()

    @router.post("/admin/api/config", dependencies=[Depends(require_admin)])
    async def admin_config_save(request: Request):
        try:
            patch = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        if not isinstance(patch, dict):
            raise HTTPException(status_code=400, detail="请求体必须是对象")
        # 丢弃客户端回传的脱敏哨兵：UI 把密钥 / 地址池打码成 HIDDEN，若原样写回会
        # 把真实密钥 / 池 JSON 覆盖成星号。只有非哨兵的值才允许落地。
        patch = {k: v for k, v in patch.items() if v != HIDDEN}
        # 切 TTS 提供商时若音色不匹配（如 deepseek + edge 音色），自动归一化为新提供商的默认音色，
        # 从源头杜绝「TTS 502 → health 判失败 → 网关卡启动」（真机踩坑）。
        patch = normalize_tts_voice_on_provider_change(patch)
        err = write_voice_config(patch)
        if err:
            raise HTTPException(status_code=500, detail=err)
        # ASR/TTS 保存勾选：两张表严格分离。
        # - speech_models 是「基础模型库」（全量官方目录），只由 seed / init_catalog.py 维护，
        #   保存动作绝不写它，否则用户取消勾选的模型会被 upsert 回基础库、永远删不掉。
        # - enabled_speech_models 是「实际启用」的勾选数据，按 (kind, provider) 整体替换：
        #   取消勾选即删除，默认模型随勾选一起记录。
        for _provider, _pairs in (
            ("builtin", (
                ("stt", "STT_BUILTIN_MODELS", "STT_BUILTIN_MODEL"),
                ("tts", "TTS_BUILTIN_MODELS", "TTS_BUILTIN_MODEL"),
            )),
            ("dashscope", (
                ("stt", "STT_UPSTREAM_MODELS", "STT_UPSTREAM_MODEL"),
                ("tts", "TTS_UPSTREAM_MODELS", "TTS_UPSTREAM_MODEL"),
            )),
            ("deepseek", (
                ("stt", "STT_DEEPSEEK_MODELS", "STT_DEEPSEEK_MODEL"),
                ("tts", "TTS_DEEPSEEK_MODELS", "TTS_DEEPSEEK_MODEL"),
            )),
        ):
            for _kind, _mk, _dmk in _pairs:
                if _mk not in patch:
                    continue
                try:
                    _models = json.loads(patch.get(_mk) or "[]")
                except Exception:
                    _models = []
                if not isinstance(_models, list):
                    _models = []
                _def = (patch.get(_dmk) or "").strip()
                voice_db.replace_enabled_models(
                    _kind, _provider,
                    [m for m in _models if isinstance(m, str)],
                    _def,
                )
        # 配置可能改了上游地址池（LLM/STT/TTS_UPSTREAM_POOL 等），清掉池缓存，
        # 下次请求立即按新配置重新解析，不必重启服务。
        upstream_pool.invalidate()
        # 保存即触发一次远程同步（best-effort，失败不影响本地）。调用方无需关心远程。
        push = None
        try:
            push = await config_store.instance().sync_push()
        except Exception as e:  # noqa: BLE001
            push = {"ok": False, "error": str(e)}
        return {"ok": True, "remote_push": push}

    # ── ASR 热词纠错词表（管理端）：分页/主表明细 + 启用/禁用/审核/添加 ──
    @router.get("/admin/api/corrections", dependencies=[Depends(require_admin)])
    def admin_corrections_list(page: int = 1, page_size: int = 10, scope: str = "", q: str = ""):
        store = voice_correction_store.get_store()
        if scope == "review":  # 审核 tab：客户端上传的按子表分页
            return store.list_review(page=page, page_size=page_size, q=q)
        return store.list_grouped(page=page, page_size=page_size, q=q)

    @router.post("/admin/api/corrections", dependencies=[Depends(require_admin)])
    async def admin_corrections_post(request: Request):
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        store = voice_correction_store.get_store()
        op = str(body.get("op") or "").strip()
        if op == "approve":  # 审核通过子表：reviewed+enabled，并自动启用主表
            # 与手动添加共用同一套字数/词性校验：不合规的词不允许审核通过并同步给设备。
            correct = str(body.get("correct") or "").strip()
            wrong = str(body.get("wrong") or "").strip()
            _validate_hotword(correct, wrong)
            return {"ok": store.approve_variant(int(body.get("variant_id") or 0))}
        if op == "delete_main":  # 删主表（级联删其下所有错词）
            return {"ok": store.delete_main(int(body.get("main_id") or 0))}
        if op == "delete_variant":  # 删一条子表错词
            return {"ok": store.delete_variant(int(body.get("variant_id") or 0))}
        if op in ("set_enabled", "set_reviewed"):  # 启用/禁用、审核标记
            mid = int(body.get("main_id") or 0)
            vid = int(body.get("variant_id") or 0)
            value = bool(body.get("value"))
            if mid:
                ok = store.set_main_enabled(mid, value) if op == "set_enabled" else store.set_main_reviewed(mid, value)
            else:
                ok = store.set_enabled(vid, value) if op == "set_enabled" else store.set_reviewed(vid, value)
            return {"ok": ok}
        # 添加：只 correct=建主表（默认禁用，需启用）；correct+wrong=加子表错词
        correct = str(body.get("correct") or "").strip()
        wrong = str(body.get("wrong") or "").strip()
        if not correct:
            raise HTTPException(status_code=400, detail="correct 不能为空")
        # 字数/形态/词性校验（添加与审核通过共用同一套规则）
        _validate_hotword(correct, wrong)
        def calc_py(w):
            try:
                from pypinyin import lazy_pinyin
                return " ".join(lazy_pinyin(w))
            except Exception:
                return ""
        # 查重只看文字，与来源无关：已存在就报错，绝不覆盖原记录（含其来源/启用/审核状态）
        if not wrong:
            if store.find_main(correct):
                raise HTTPException(status_code=409, detail="config.hotwordDupMain")
            result = store.upsert_main_only(correct, calc_py(correct), "local", "")
            store.set_main_enabled(result["main_id"], False)  # 本地添加默认禁用
            return {"ok": True, **result, "enabled": 0}
        if store.find_exact(correct, wrong):
            raise HTTPException(status_code=409, detail="config.hotwordDupVariant")
        # 加子表错词（本地添加 source=local，默认禁用）
        result = store.upsert(correct, calc_py(correct), wrong, calc_py(wrong), source="local")
        store.set_enabled(result["variant_id"], False)
        return {"ok": True, **result, "enabled": 0}

    @router.get("/admin/api/log-files", dependencies=[Depends(require_viewer)])
    def admin_log_files():
        return {"files": list_log_files()}

    @router.get("/admin/api/logs", dependencies=[Depends(require_viewer)])
    def admin_logs(n: int = 200, name: str = "", q: str = "",
                   start_date: str = "", end_date: str = "", head: bool = False):
        if n <= 0 or n > 2000:
            n = 200
        return Response(voice_logs(n, name or None, q or None, start_date or None,
                                   end_date or None, head=head),
                        media_type="text/plain; charset=utf-8")

    @router.post("/admin/api/action", dependencies=[Depends(require_admin)])
    async def admin_action(request: Request):
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        action = body.get("action") if isinstance(body, dict) else None
        if not action:
            raise HTTPException(status_code=400, detail="缺少 action")
        # voice_action 里是同步 subprocess.run（timeout=60），直接调用会阻塞唯一
        # 的事件循环、让整个 19529 停摆；放到线程池执行。
        return await asyncio.to_thread(voice_action, action)

    @router.post("/admin/api/sync", dependencies=[Depends(require_admin)])
    async def admin_sync():
        """手动触发双向同步：远端 -> 本地合并，再 本地 -> 远端；缓存与 DB 调用方无感。"""
        store = config_store.instance()
        pulled = await store.sync_pull()
        push = await store.sync_push()
        return {
            "ok": True,
            "pulled_keys": len(pulled),
            "push": push,
            "remote": store.status()["remote"],
        }

    @router.get("/admin/api/schema-history", dependencies=[Depends(require_viewer)])
    def admin_schema_history():
        """表结构变更记录：每一版做了什么、何时应用。新增表/列必须同步 SCHEMA_CHANGES。"""
        return {"ok": True, "current": voice_db.SCHEMA_VERSION,
                "changes": voice_db.schema_history()}

    @router.get("/admin/api/speech-models", dependencies=[Depends(require_viewer)])
    def admin_speech_models(kind: str = "", provider: str = ""):
        """基础模型库（speech_models 表）：全量官方目录，按 kind/provider 过滤。

        这是「可以勾什么」的全量清单（点刷新按钮展示的就是它），只由 seed /
        init_catalog.py 维护，不随用户勾选变化。
        """
        rows = voice_db.list_speech_models(
            (kind or "").strip().lower() or None,
            (provider or "").strip().lower() or None,
        )
        return {"ok": True, "models": rows}

    @router.get("/admin/api/enabled-models", dependencies=[Depends(require_viewer)])
    def admin_enabled_models(kind: str = "", provider: str = ""):
        """实际启用的模型（enabled_speech_models 表）：用户勾选、真正要用上的。

        与基础库分离：这里只有勾选中的数据，含 is_default（该 provider 的默认模型）。
        """
        rows = voice_db.list_enabled_models(
            (kind or "").strip().lower() or None,
            (provider or "").strip().lower() or None,
        )
        return {"ok": True, "models": rows}

    return router
