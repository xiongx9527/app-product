"""上游地址池（仅 LLM）：健康探测 + 轮询。

为什么独立成模块：上游只有 LLM 有（STT / TTS 固定本地实现）。管理面板把 LLM 配置成
固定两个提供商（ollama / 自定义），各一条入口写进 LLM_UPSTREAM_POOL。把池子的解析、
健康状态、调度收口到这里，调用方（chat_completions）只调 pick() 拿一个
(base_url, api_key, protocol)，完全不感知后面有几台机器、谁挂了。

配置（存进 config_kv，经 config_store 读取）。面板写出扁平数组（每个固定提供商一条），
load_pool 也向后兼容以下三种写法：

1) 按提供商分组 + 整组固定模型（推荐；一个分组模型类型是定的）：
    LLM_UPSTREAM_POOL = {
      "openai":   {"model": "gpt-4o-mini",
                   "accounts": [{"base_url": "https://api.openai.com/v1", "api_key": "sk-..."},
                               {"base_url": "https://api.openai.com/v1", "api_key": "sk-2"}]},
      "deepseek": {"model": "deepseek-chat",
                   "accounts": [{"base_url": "https://api.deepseek.com", "api_key": "sk-..."}]}
    }
2) 按提供商分组（简写，无整组 model；每个入口自带 model）：
    LLM_UPSTREAM_POOL = {
      "openai":   [{"base_url": "https://api.openai.com/v1", "api_key": "sk-...", "model": "gpt-4o-mini"}],
      "deepseek": [{"base_url": "https://api.deepseek.com", "api_key": "sk-...", "model": "deepseek-chat"}]
    }
3) 扁平数组（旧写法，向后兼容；每个条目自带 protocol / model）：
    LLM_UPSTREAM_POOL = [
      {"base_url": "...", "api_key": "sk-...", "protocol": "deepseek", "model": "deepseek-chat"},
      {"base_url": "...", "api_key": "sk-...", "protocol": "openai", "model": "gpt-4o-mini"}
    ]
model 优先级：入口自己的 model > 分组级 model > 全局 LLM_UPSTREAM_MODEL >
客户端请求里的 model。整组固定 model 让「一个分组一个模型类型」时只写一次。
向后兼容：没配 LLM_UPSTREAM_POOL 时，退回单个 LLM_UPSTREAM_BASE_URL(+KEY+PROTOCOL)。

调度：在「健康」的入口里轮询；全部不健康时退化为全量（避免全 outage 时彻底不可用）。
健康：后台线程定期探测。健康账号只做轻量存活探测；被运行时失败累计 3 次摘掉的账号
进入冷却（默认 60s），冷却结束后做「可用性」深度探测（带密钥打模型列表接口），
只有真正返回可用（密钥有效、接口正常）才放回轮询——即「测试正常后继续加入」，
且「加入的账号必须测试有用」，不会再凭时间或单纯连得通就加回一个还坏的账号。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Optional

import config_store
import httpx
import llm_protocols  # 协议归一化：厂商式协议名 -> 线协议

CAPS = ("LLM",)
_FAIL_THRESHOLD = 3
_COOLDOWN = 60.0
_PROBE_INTERVAL = 15.0
_PROBE_TIMEOUT = 3.0
# 模型名前缀可识别的提供商；用于单地址写法（无显式 vendor 字段）时推导 vendor。
_KNOWN_VENDORS = {
    "openai", "azure", "deepseek", "dashscope", "aliyun", "qwen", "ollama", "anthropic",
    "gemini", "google", "moonshot", "kimi", "glm", "zhipu", "minimax", "step", "baichuan",
    "doubao", "volcengine", "yi", "01ai", "spark", "iflytek", "tencent", "hunyuan",
}

_lock = threading.Lock()
# 已解析的池缓存（带 TTL，避免每次请求都解析 JSON）。
_pool_cache: dict[str, tuple[float, list[dict]]] = {}
_pool_cache_ttl = 5.0
# 健康状态：key = "cap|base_url|api_key"
_health: dict[str, dict[str, Any]] = {}
# 每能力的轮询下标
_rr: dict[str, int] = {}


def _pool_config_key(cap: str) -> str:
    return f"{cap}_UPSTREAM_POOL"


def _legacy_single(cap: str) -> Optional[dict]:
    """没有池配置时，用旧的单个地址配置拼一个入口（向后兼容）。仅 LLM 支持单地址写法。

    cap 不是 LLM 时一律返回 None：每个能力只在自己的池键为空时才退到「单地址」兜底，
    不能把 LLM 的单地址配置借给别的 cap 当默认值——那样会让 EMBED 等独立能力的面板
    凭空显示出 LLM 的入口，与「各能力数据相互独立」相悖。调用时刻的兜底（如
    embeddings 在 EMBED 池为空时改打 LLM 池）由各自的路由逻辑负责，不在池解析里借数据。
    """
    if cap != "LLM":
        return None
    try:
        store = config_store.instance()
    except RuntimeError:
        return None
    base = (store.get("LLM_UPSTREAM_BASE_URL") or "").strip()
    if not base:
        return None
    model = (store.get("LLM_UPSTREAM_MODEL") or "").strip()
    # 单地址写法没有显式 vendor 字段，用模型名前缀推导（deepseek-chat -> deepseek），
    # 让测试界面的「提供商」下拉能列出这一家；推导不出则留空。
    vendor = (store.get("LLM_UPSTREAM_VENDOR") or "").strip()
    if not vendor:
        head = model.split("-", 1)[0].lower()
        if head in _KNOWN_VENDORS:
            vendor = head
    return {
        "base_url": base,
        "api_key": (store.get("LLM_UPSTREAM_API_KEY") or "").strip(),
        "protocol": (store.get("LLM_UPSTREAM_PROTOCOL") or "openai").strip() or "openai",
        "model": model,
        "vendor": vendor,
    }


def _normalize_entry(
    e: dict,
    group_protocol: str | None = None,
    group_model: str | None = None,
    group_vendor: str | None = None,
) -> dict:
    """把一个入口原始 dict 收敛成标准形状。

    protocol 经 llm_protocols.normalize_protocol() 收敛到 5 个线协议之一
    （openai_chat_completions / azure_openai_chat_completions / openai_responses /
    anthropic_messages / gemini）；vendor 单独记录（deepseek / dashscope / ollama
    等），用于决定 baseUrl 路径变体。group_* 来自「按提供商分组」的键与分组级 model。

    入口自己的 protocol / vendor / model 优先级最高，可覆盖分组默认值。
    """
    raw_proto = (e.get("protocol") or group_protocol or "openai").strip() or "openai"
    proto = llm_protocols.normalize_protocol(raw_proto)
    vendor = (
        e.get("vendor")
        or group_vendor
        or llm_protocols.protocol_vendor(raw_proto)
        or ""
    ).strip().lower()
    model = (e.get("model") or group_model or "").strip()
    return {
        "base_url": (e.get("base_url") or "").strip(),
        "api_key": (e.get("api_key") or "").strip(),
        "protocol": proto,
        "vendor": vendor,
        "model": model,
    }


def load_pool(cap: str) -> list[dict]:
    """读配置解析出该能力的上游入口列表（池优先，无池则退回单个旧配置）。

    支持三种写法：
      - 按提供商分组（模型按组固定）：
            {"openai": {"model": "gpt-4o-mini",
                        "accounts": [{"base_url": "...", "api_key": "sk-..."}, ...]},
             "deepseek": {"model": "deepseek-chat",
                          "accounts": [{"base_url": "...", "api_key": "sk-..."}]}}
        protocol 取分组键，model 取分组级（组内入口可不写）；
      - 按提供商分组（简写，无分组级 model）：
            {"openai": [{"base_url": "...", "api_key": "sk-..."}], ...}
      - 扁平数组（旧写法，向后兼容）：
            [{"base_url": "...", "protocol": "openai", "model": "..."}, ...]
    """
    now = time.time()
    cached = _pool_cache.get(cap)
    if cached and now - cached[0] < _pool_cache_ttl:
        return cached[1]
    entries: list[dict] = []
    try:
        raw = config_store.instance().get(_pool_config_key(cap), "") or ""
        if raw:
            arr = json.loads(raw)
            if isinstance(arr, dict):
                # 按提供商分组：key 即 protocol；值可是「入口数组」或
                # 「{model, accounts}」对象（整组用一个 model）。
                for provider, spec in arr.items():
                    group_vendor = llm_protocols.protocol_vendor(provider)
                    if isinstance(spec, list):
                        for e in spec:
                            if isinstance(e, dict) and (e.get("base_url") or "").strip():
                                entries.append(
                                    _normalize_entry(
                                        e, group_protocol=provider, group_vendor=group_vendor
                                    )
                                )
                    elif isinstance(spec, dict):
                        gmodel = (spec.get("model") or "").strip()
                        accts = spec.get("accounts") or spec.get("entries") or []
                        if isinstance(accts, list):
                            for e in accts:
                                if isinstance(e, dict) and (e.get("base_url") or "").strip():
                                    entries.append(
                                        _normalize_entry(
                                            e,
                                            group_protocol=provider,
                                            group_model=gmodel,
                                            group_vendor=group_vendor,
                                        )
                                    )
            elif isinstance(arr, list):
                for e in arr:
                    if isinstance(e, dict) and (e.get("base_url") or "").strip():
                        entries.append(_normalize_entry(e))
    except Exception:
        entries = []
    if not entries:
        single = _legacy_single(cap)
        if single:
            entries.append(single)
    with _lock:
        _pool_cache[cap] = (now, entries)
    return entries


def has_upstream(cap: str) -> bool:
    """是否配置了该能力上游（池或旧的单个地址皆可）。

    与 pick() 不同：只判断、不轮询、不写健康状态，适合做「是否启用代理」的开关
    和 /health 报告，避免健康检查自己把轮询下标往前推、或误建健康条目。
    """
    return bool(load_pool(cap))


def invalidate() -> None:
    """配置变更后清掉池缓存，下次请求立即重新解析。"""
    with _lock:
        _pool_cache.clear()


def _hid(key: str) -> str:
    return "********" if key else ""


def _health_key(cap: str, e: dict) -> str:
    return f"{cap}|{e['base_url']}|{e['api_key']}"


def _ensure_health(cap: str, e: dict) -> dict:
    k = _health_key(cap, e)
    h = _health.get(k)
    if h is None:
        h = {"healthy": True, "fails": 0, "last_error": None, "last_probe": 0.0}
        _health[k] = h
    return h


# 上游模型列表缓存：按 (base_url, protocol, vendor) 缓存探测结果，TTL 内不重复探测。
# 用于对外接口「模型存在性」校验——只依赖缓存数据，不每次发实时探测。
_MODEL_CACHE: dict[tuple, tuple[float, Optional[list[str]]]] = {}
_MODEL_CACHE_TTL = 60.0


async def list_provider_models(
    base_url: str, api_key: str, protocol: str, vendor: str | None = None
) -> Optional[list[str]]:
    """缓存地列出上游模型的 id；探测失败 / 不支持枚举时返回 None（调用方应跳过校验，不误杀）。

    命中缓存直接返回，避免每次请求都打上游；仅在 TTL 过期后才重新探测一次。
    """
    key = (base_url.rstrip("/"), protocol or "", vendor or "")
    now = time.time()
    cached = _MODEL_CACHE.get(key)
    if cached and now - cached[0] < _MODEL_CACHE_TTL:
        return cached[1]
    models = await _probe_models(base_url, api_key, protocol, vendor)
    _MODEL_CACHE[key] = (now, models)
    return models


async def _probe_models(
    base_url: str, api_key: str, protocol: str, vendor: str | None
) -> Optional[list[str]]:
    """实际探测上游模型列表：优先 OpenAI 兼容 /v1/models，ollama 再试 /api/tags。"""
    base = (base_url or "").rstrip("/")
    if not base:
        return None
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # OpenAI 兼容端点（ollama 也支持）
            try:
                r = await client.get(base + "/v1/models", headers=headers)
                if r.status_code == 200:
                    arr = (r.json().get("data") or []) if r.content else []
                    ids = [m.get("id") for m in arr if isinstance(m, dict) and m.get("id")]
                    if ids:
                        return ids
            except Exception:
                pass
            # ollama 原生端点兜底：只认 protocol，vendor 只是分组标签不切换协议
            if (protocol or "").strip().lower() == "ollama":
                try:
                    r = await client.get(base + "/api/tags", headers=headers)
                    if r.status_code == 200:
                        ms = (r.json().get("models") or []) if r.content else []
                        ids = [
                            m.get("name") or m.get("model")
                            for m in ms
                            if isinstance(m, dict)
                        ]
                        ids = [i for i in ids if i]
                        if ids:
                            return ids
                except Exception:
                    pass
    except Exception:
        return None
    return None


def _pick_from(pool_list: list[dict], cap: str) -> Optional[dict]:
    """在给定入口列表里做「健康优先 + 轮询」；全不健康时退化为全量。"""
    if not pool_list:
        return None
    with _lock:
        healthy = [e for e in pool_list if _ensure_health(cap, e)["healthy"]]
    pool = healthy if healthy else pool_list
    idx = _rr.get(cap, 0) % len(pool)
    _rr[cap] = idx + 1
    return pool[idx]


def pick(cap: str) -> Optional[dict]:
    """在健康入口里轮询返回一个；全不健康时退化为全量（避免彻底不可用）。"""
    return _pick_from(load_pool(cap), cap)


def pick_by_model(cap: str, model: str | None) -> Optional[dict]:
    """按请求模型路由到对应分组（提供商），再在组内多账号间轮询。

    接口通过模型名定位到「哪个分组」——请求的 model 与各入口的 model 匹配即选中该
    分组；选中后在分组内的多个 LLM（账号 / 地址）之间做健康优先 + 轮询「内部消化」。
    没有任何分组的模型匹配该请求时，退回全局健康优先 + 轮询，保证仍可用。
    """
    entries = load_pool(cap)
    if not entries:
        return None
    if model:
        matched = [e for e in entries if e.get("model") == model]
        if matched:
            return _pick_from(matched, cap)
    return _pick_from(entries, cap)


def pick_by_vendor(cap: str, vendor: str) -> Optional[dict]:
    """按提供商（vendor）选出该提供商的入口再做健康优先 + 轮询。

    测试界面 / 调用方可显式指定想打哪个提供商；vendor 为空或没匹配到时退回全局轮询。
    """
    entries = load_pool(cap)
    if not entries:
        return None
    if vendor:
        matched = [e for e in entries if (e.get("vendor") or "").strip().lower() == vendor.strip().lower()]
        if matched:
            return _pick_from(matched, cap)
    return _pick_from(entries, cap)


def mark_success(cap: str, entry: dict) -> None:
    with _lock:
        h = _ensure_health(cap, entry)
        h["healthy"] = True
        h["fails"] = 0
        h["last_error"] = None


def mark_failure(cap: str, entry: dict, status: Optional[int] = None) -> None:
    with _lock:
        h = _ensure_health(cap, entry)
        h["fails"] += 1
        h["last_error"] = f"HTTP {status}" if status else "连接失败"
        if h["fails"] >= _FAIL_THRESHOLD:
            h["healthy"] = False
            h["last_probe"] = time.time() + _COOLDOWN  # 冷却后再探


def health_snapshot(cap: str) -> list[dict]:
    entries = load_pool(cap)
    out = []
    for e in entries:
        with _lock:
            h = _ensure_health(cap, e)
            # 只读快照：绝不在这里改健康状态。被摘除的账号要等后台探测（_probe_loop）
            # 确认可达后，才被重新标记为健康并放回轮询——即「测试正常后继续加入」，
            # 而不是冷却时间一到就凭时间放回去（那样可能把一个还死的账号又加进来）。
            cooling = bool(h["last_probe"]) and time.time() < h["last_probe"]
            out.append(
            {
                "base_url": e["base_url"],
                "api_key": _hid(e["api_key"]),
                "protocol": e["protocol"] or None,
                "vendor": e.get("vendor") or None,
                "model": e["model"] or None,
                "healthy": h["healthy"],
                "cooling": cooling,
                "fails": h["fails"],
                "last_error": h["last_error"],
            }
        )
    return out


# ── 后台健康探测线程 ───────────────────────────────────────────────
def _probe_target(entry: dict) -> tuple[str, dict[str, str]]:
    """构造「验证账号是否有用」的轻量探测目标：各协议取模型列表接口并带鉴权。

    能 2xx 回来即说明账号可用（密钥有效、接口正常）；这正是「加入的账号必须测试有用」
    要检查的东西。Ollama 用 /api/tags，其余 OpenAI 兼容用 /v1/models。
    """
    base = (entry.get("base_url") or "").rstrip("/")
    proto = llm_protocols.normalize_protocol(entry.get("protocol"))
    vendor = (entry.get("vendor") or llm_protocols.protocol_vendor(entry.get("protocol")) or "").lower()
    key = entry.get("api_key") or ""
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    if vendor == "ollama":
        return base + "/api/tags", headers
    if proto == "gemini":
        return base + "/models", headers
    if base.endswith("/v1"):
        return base + "/models", headers
    return base + "/v1/models", headers


async def _probe_reach(entry: dict) -> tuple[bool, Optional[str]]:
    """存活探测：只确认主机连得上（任何 HTTP 响应都算在线）。

    用于已在轮询中的健康账号，成本低；连不通才把它摘掉进入冷却 + 待深度探测。
    """
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as c:
            await c.get(entry["base_url"])
        return True, None
    except httpx.HTTPError as exc:
        return False, str(exc)[:120]
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:120]


async def _probe_useful(entry: dict) -> tuple[bool, Optional[str]]:
    """可用性探测：带密钥打模型列表接口，真正验证「这个账号有用」。

    只有主机在线、密钥有效（2xx，或路径差异导致的 404/400 等 4xx）才视为可用；
    鉴权失败（401/403）说明密钥无效、服务端 5xx 说明上游坏——这些都不算「有用」，
    账号不会被加回轮询，直到下一次探测通过。
    """
    url, headers = _probe_target(entry)
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as c:
            r = await c.get(url, headers=headers)
        if 200 <= r.status_code < 300:
            return True, None
        if r.status_code in (401, 403):
            return False, f"HTTP {r.status_code}（密钥可能无效）"
        if 500 <= r.status_code < 600:
            return False, f"HTTP {r.status_code}（上游服务端错误）"
        # 其它 4xx（404/400/405 等）：主机在线、只是路径 / 参数差异，按可用放行保兼容。
        return True, None
    except httpx.HTTPError as exc:
        return False, str(exc)[:120]
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:120]


async def _probe_loop() -> None:
    while True:
        try:
            for cap in CAPS:
                for e in load_pool(cap):
                    h = _ensure_health(cap, e)
                    cooling = bool(h["last_probe"]) and time.time() < h["last_probe"]
                    if h["healthy"]:
                        # 健康账号：只做轻量存活探测，掉线就摘掉进冷却。
                        ok, err = await _probe_reach(e)
                        with _lock:
                            if ok:
                                h["last_probe"] = time.time()
                                h["last_error"] = None
                            else:
                                h["healthy"] = False
                                h["last_probe"] = time.time() + _COOLDOWN
                                h["last_error"] = err
                    else:
                        # 已摘除 / 冷却中：冷却期内不探测，等冷却结束再做「可用性」深度探测。
                        if cooling:
                            continue
                        ok, err = await _probe_useful(e)
                        with _lock:
                            if ok:
                                # 测试正常，放回轮询。
                                h["healthy"] = True
                                h["fails"] = 0
                                h["last_error"] = None
                                h["last_probe"] = time.time()
                            else:
                                # 还没好：保持摘除，下一轮继续探，直到真正有用才加回。
                                h["healthy"] = False
                                h["last_probe"] = time.time()
                                h["last_error"] = err
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(_PROBE_INTERVAL)


def start_health_probing(interval: float = _PROBE_INTERVAL) -> None:
    """启动守护线程跑健康探测（自带事件循环，与 uvicorn 主循环解耦）。"""
    global _PROBE_INTERVAL
    _PROBE_INTERVAL = interval

    def _run() -> None:
        try:
            asyncio.run(_probe_loop())
        except Exception:  # noqa: BLE001
            pass

    t = threading.Thread(target=_run, daemon=True, name="upstream-health")
    t.start()
