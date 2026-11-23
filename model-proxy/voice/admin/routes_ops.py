"""管理面板路由 · 连通测试 / 模型下拉 / 上游池 / 启停域。

由 admin_panel.register_admin_routes 在运行时加载。四个检测回调由 register 注入，
避免依赖主模块的模块级可变全局。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

import config_store
import httpx
import llm_protocols
import upstream_pool
import admin_panel as ap  # 鉴权依赖；调用时根模块已完全加载


def build_router(
    stt_builtin_check=None,
    tts_builtin_check=None,
    stt_upstream_test=None,
    tts_upstream_test=None,
) -> APIRouter:
    """创建「运维探测」域的 router；回调由 register_admin_routes 注入。"""
    router = APIRouter()
    require_admin = ap.require_admin
    require_operator = ap.require_operator
    _STT_BUILTIN_CHECK = stt_builtin_check
    _TTS_BUILTIN_CHECK = tts_builtin_check
    _STT_UPSTREAM_TEST = stt_upstream_test
    _TTS_UPSTREAM_TEST = tts_upstream_test

    @router.get("/admin/api/llm-pool", dependencies=[Depends(require_admin)])
    def admin_llm_pool():
        """LLM 上游按提供商分组返回。详见 admin_pool。"""
        return admin_pool("LLM", "LLM_UPSTREAM_VENDOR", "LLM_UPSTREAM_MODEL")

    @router.get("/admin/api/embed-pool", dependencies=[Depends(require_admin)])
    def admin_embed_pool():
        """向量（embeddings）上游按提供商分组返回：与 LLM 结构完全一致，但数据独立存储
        （EMBED_UPSTREAM_POOL），互不影响——改一个不会同步/覆盖另一个。"""
        return admin_pool("EMBED", "EMBED_UPSTREAM_VENDOR", "EMBED_UPSTREAM_MODEL")

    @router.get("/admin/api/rerank-pool", dependencies=[Depends(require_admin)])
    def admin_rerank_pool():
        """重排（rerank）上游按提供商分组返回：与 LLM/EMBED 结构一致，但数据独立存储
        （RERANK_UPSTREAM_POOL），互不影响。"""
        return admin_pool("RERANK", "RERANK_UPSTREAM_VENDOR", "RERANK_UPSTREAM_MODEL")

    @router.get("/admin/api/speech-secrets", dependencies=[Depends(require_admin)])
    def admin_speech_secrets():
        """ASR/TTS 上游（dashscope / deepseek）的 API Key 真实值：仅供编辑框预填（与 LLM 池同口径，
        明文返回、仅本地同源可达）。通用 /admin/api/config 仍打码，密钥不在此泄露。"""
        cfg = config_store.instance().all()
        return {
            "STT_UPSTREAM_API_KEY": cfg.get("STT_UPSTREAM_API_KEY") or "",
            "TTS_UPSTREAM_API_KEY": cfg.get("TTS_UPSTREAM_API_KEY") or "",
            "STT_DEEPSEEK_API_KEY": cfg.get("STT_DEEPSEEK_API_KEY") or "",
            "TTS_DEEPSEEK_API_KEY": cfg.get("TTS_DEEPSEEK_API_KEY") or "",
        }

    def admin_pool(cap: str, def_vendor_key: str, def_model_key: str):
        """上游池按提供商分组返回：每组含厂商、协议、去重模型列表、账号清单（地址/Key/本账号模型）。
        供配置页表格渲染（提供商上下合并、模型映射）使用。账号里的 api_key 为明文（管理端点，
        仅本地同源可达），前端预填进密码框，留空即视为「清空该 Key」。
        cap 区分 LLM / EMBED，两者各自读各自的池（LLM_UPSTREAM_POOL / EMBED_UPSTREAM_POOL），
        保证 embeddings 配置数据与对话配置数据完全独立。"""
        entries = upstream_pool.load_pool(cap)
        groups: dict[str, Any] = {}
        order: list[str] = []
        for e in entries:
            v = (e.get("vendor") or e.get("protocol") or "unknown")
            if v not in groups:
                # 同一提供商下，base_url+api_key 相同的入口视为「同一个账号」，合并成一行；
                # 模型统一挂在组级，不按模型数膨胀出行（否则保存次数越多行越多）。
                groups[v] = {"vendor": v, "protocol": e.get("protocol") or "", "models": set(), "accounts": [], "_seen_acc": set()}
                order.append(v)
            g = groups[v]
            m = e.get("model")
            if m:
                g["models"].add(m)
            acc_key = (e.get("base_url", "") or "", e.get("api_key", "") or "")
            if acc_key not in g["_seen_acc"]:
                g["_seen_acc"].add(acc_key)
                g["accounts"].append({"base_url": acc_key[0], "api_key": acc_key[1]})
        out = [
            {
                "vendor": groups[v]["vendor"],
                "protocol": groups[v]["protocol"],
                "models": sorted(groups[v]["models"]),
                "accounts": groups[v]["accounts"],
            }
            for v in order
        ]
        default_vendor = config_store.instance().get(def_vendor_key, "") or ""
        default_model = config_store.instance().get(def_model_key, "") or ""
        # 按提供商维度的默认模型（*_UPSTREAM_DEFAULT_MODELS，JSON map: vendor -> model）。
        # 每个提供商各自一个默认，互不覆盖；def_model_key 只作为全局兼容镜像。
        raw_def_models = config_store.instance().get(f"{cap}_UPSTREAM_DEFAULT_MODELS", "") or ""
        try:
            parsed = json.loads(raw_def_models) if raw_def_models else {}
        except Exception:
            parsed = {}
        default_models = (
            {str(k): str(v) for k, v in parsed.items() if k and v}
            if isinstance(parsed, dict) else {}
        )
        return {"groups": out, "default_vendor": default_vendor,
                "default_model": default_model, "default_models": default_models}

    @router.post("/admin/api/stt-builtin-test", dependencies=[Depends(require_operator)])
    async def admin_stt_builtin_test():
        """按需真实检测内置（本地 SenseVoice）是否可用。

        启动阶段不做任何检测：内置可用性只在这里点「测试可用」时验证。检测会真正
        加载 240MB 模型并跑一次推理，放到线程里避免阻塞事件循环。
        """
        if _STT_BUILTIN_CHECK is None:
            return {"ok": False, "reason": "not_wired", "detail": "检测能力未注入"}
        try:
            return await asyncio.to_thread(_STT_BUILTIN_CHECK)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "exception", "detail": str(exc)}

    # DashScope 语音模型清单：HTTP 与 WS 协议的模型都列出，面板按协议小字如实
    # 标注（ws 模型当前账号未开通会测试失败，但保留在列表里供用户查看/选择）。
    # 依据：实测（qwen3-tts-flash 合成 / qwen3-asr-flash 识别成功）+ 官方文档
    # model-list-speech-{synthesis,recognition}。
    DASHSCOPE_VOICE_MODELS = {
        "tts": [
            "qwen3-tts-flash",           # ✅ 实测合成成功（http）
            "qwen-tts",                   # 同端点（multimodal-generation，http）
            "qwen-audio-3.0-tts-flash",   # HTTP 直回音频（官方 HTTP SDK 示例）
            "qwen-audio-3.0-tts-plus",
            "qwen-audio-3.1-tts-flash",
            "qwen-audio-3.1-tts-next",
            "cosyvoice-v3-flash",         # ws ✅ 实测可用（音色 longanyang）
            "cosyvoice-v3-plus",          # ws ✅ 实测可用
            "cosyvoice-v2",               # ws ✅ 实测可用（音色 longxiaochun_v2）
            "cosyvoice-v1",               # ws 官方已于 2026-10-10 下线（长尾模型下线公告），
                                          #    全网 Model not exist，非账号问题；留作对照
        ],
        "stt": [
            # Paraformer 系（实时 + 录音文件）
            "paraformer-realtime-v2",     # ws
            "paraformer-realtime-v1",     # ws
            "paraformer-realtime-8k-v2",  # ws（电话 8k）
            "paraformer-realtime-8k-v1",  # ws（电话 8k）
            "paraformer-v2",              # http-async（录音文件）
            "paraformer-v1",              # http-async（录音文件）
            "paraformer-8k-v2",           # http-async（电话 8k）
            "paraformer-8k-v1",           # http-async（电话 8k）
            "paraformer-mtl-v1",          # http-async（多语种）
            # Fun-ASR 系（中英自由切换、噪声鲁棒）
            "fun-asr",                    # http-async（录音文件）
            "fun-asr-realtime",           # ws
            "fun-asr-realtime-2026-02-28",# ws
            "fun-asr-flash-2026-06-15",   # ws
            "fun-asr-flash-8k-realtime",  # ws（电话 8k）
            "fun-asr-mtl",                # http-async（多语种）
            # Qwen-ASR 系
            "qwen3-asr-flash",            # ✅ 实测识别成功（http）
            "qwen3-asr-flash-realtime",   # ws
            "qwen3-asr-flash-filetrans",  # http-async（录音文件）
            "qwen-audio-3.0-asr-flash",
            "qwen-audio-3.0-asr-flash-streaming",   # ws
            "qwen-audio-3.0-asr-flash-filetrans",   # http-async
            "qwen-audio-3.1-asr-flash",
            "qwen-audio-3.1-asr-flash-streaming",   # ws
            "qwen-audio-3.1-asr-flash-filetrans",   # http-async
            "qwen-audio-3.1-asr-flash-message",
            # Gummy 系（识别/翻译）
            "gummy-realtime-v1",          # ws（翻译）
            "gummy-chat-v1",              # ws（翻译）
            # 其他
            "sensevoice-v1",              # http-async（录音文件）
        ],
    }

    @router.post("/admin/api/dashscope-models", dependencies=[Depends(require_operator)])
    async def admin_dashscope_models(request: Request):
        """返回 DashScope 的语音模型清单（按 kind 分族），供面板「刷新模型」列出。

        HTTP 与 WS 协议模型都列出（内置清单，不发网络请求），协议由面板小字标注。
        """
        kind = None
        try:
            b = await request.json()
            if isinstance(b, dict):
                kind = b.get("kind")
        except Exception:
            pass
        kind = (kind or "tts").strip().lower()
        return {"ok": True, "models": list(DASHSCOPE_VOICE_MODELS.get(kind, []))}

    @router.post("/admin/api/stt-upstream-test", dependencies=[Depends(require_operator)])
    async def admin_stt_upstream_test(request: Request):
        """按当前 DB 配置真调一次上游 ASR；可带 {model, provider} 覆盖（模型级测试）。"""
        model = None
        provider = ""
        try:
            b = await request.json()
            if isinstance(b, dict):
                model = b.get("model")
                provider = (b.get("provider") or "").strip().lower()
        except Exception:
            pass
        if _STT_UPSTREAM_TEST is None:
            return {"ok": False, "message": "检测能力未注入"}
        return await _STT_UPSTREAM_TEST(model, provider)

    @router.post("/admin/api/tts-upstream-test", dependencies=[Depends(require_operator)])
    async def admin_tts_upstream_test(request: Request):
        """按当前 DB 配置真合成一句验证上游 TTS；可带 {model, provider} 覆盖。"""
        model = None
        provider = ""
        try:
            b = await request.json()
            if isinstance(b, dict):
                model = b.get("model")
                provider = (b.get("provider") or "").strip().lower()
        except Exception:
            pass
        if _TTS_UPSTREAM_TEST is None:
            return {"ok": False, "message": "检测能力未注入"}
        return await _TTS_UPSTREAM_TEST(model, provider)

    @router.post("/admin/api/tts-builtin-test", dependencies=[Depends(require_operator)])
    async def admin_tts_builtin_test(request: Request):
        """按需真实检测内置 TTS（edge-tts / kokoro）是否可用：按请求里的 model 合成一句。

        启动阶段不做。检测函数与线上 /voice/v1/audio/speech 走同一条本地分支。
        """
        model = ""
        try:
            _body = await request.json()
            if isinstance(_body, dict):
                model = str(_body.get("model") or "").strip()
        except Exception:  # noqa: BLE001
            pass
        if _TTS_BUILTIN_CHECK is None:
            return {"ok": False, "reason": "not_wired", "detail": "检测能力未注入"}
        try:
            return await _TTS_BUILTIN_CHECK(model)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "exception", "detail": str(exc)}

    @router.post("/admin/api/probe", dependencies=[Depends(require_operator)])
    async def admin_probe(request: Request):
        """探测任意上游连通性：给定地址/Key/协议，拉一次模型列表验证可用；支持未保存的配置。"""
        try:
            b = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        if not isinstance(b, dict):
            raise HTTPException(status_code=400, detail="请求体必须是对象")
        base = (b.get("base_url") or "").strip()
        key = (b.get("api_key") or "").strip()
        protocol = (b.get("protocol") or "openai").strip()
        if not base:
            return {"ok": False, "error": "缺少上游地址"}
        try:
            url, headers = llm_protocols.prepare_models(protocol, base, key)
        except Exception:
            url = base.rstrip("/") + "/v1/models"
            headers = {"Authorization": f"Bearer {key}"} if key else {}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(url, headers=headers)
            ok = r.status_code < 400
            names: list[str] = []
            try:
                d = r.json()
                if isinstance(d, dict):
                    if isinstance(d.get("data"), list):
                        names = [m.get("id", "") for m in d["data"] if isinstance(m, dict)]
                    elif isinstance(d.get("models"), list):
                        names = [m.get("name", "") for m in d["models"] if isinstance(m, dict)]
            except Exception:
                pass
            # 不截断：模型多时全量返回，由前端子表滚动展示（截断会让用户以为没拉全）。
            return {"ok": ok, "status": r.status_code, "models": [n for n in names if n]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    return router
