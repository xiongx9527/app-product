"""MCP server 中转网关：对外暴露 MCP（FastMCP），聚合上游 MCP server 工具并转发。

- 对外：FastMCP Server 挂到现有 FastAPI /mcp（SSE），每个工具的 list/call 按 API-Key
  (request.state.api_key_id) 过滤——见 _ToolACL middleware。
- 上游：mcp_servers 表配置，FastMCP Client(SSETransport) 连接，工具自动发现并加 <name>__ 前缀。
- 鉴权：复用 openai_voice_server 的 security_middleware（/mcp* 非白名单天然需 API-Key）。
- 依赖：langchain[mcp]（含 fastmcp + mcp SDK）；import 失败时上层返回 501，不影响主服务。
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager, AsyncExitStack
from typing import Any
from urllib.parse import urlparse

import httpx

# 参数说明兜底字典：上游 schema 通常不带 description，按参数名补中文说明，
# 让对外 MCP tools/list 的参数说明不为空（App 客户端会展示）。
_PARAM_DESC_FALLBACK: dict[str, str] = {
    "token": "访问令牌（SQLBot 兼容；主通道由网关自动注入，一般无需传）",
    "authorization": "第三方鉴权头（Bearer token）",
    "username": "用户名，用于换取访问 token",
    "password": "密码，用于换取访问 token",
    "oid": "组织/工作空间 ID",
    "workspaceid": "工作空间 ID（管理员可指定，默认当前工作空间）",
    "datasourceid": "数据源 ID，指定查询的数据源",
    "datasource_id": "数据源 ID（SQLBot 兼容命名，可为对象）",
    "chatid": "会话 ID，续接已有问数会话",
    "chat_id": "会话 ID（SQLBot 兼容命名）",
    "question": "自然语言问题（问数输入）",
    "custommodel": "按次指定对话模型 ID",
    "custom_model": "对话模型（SQLBot 兼容命名）",
    "returnimg": "是否返回图片结果（true 出图，默认 true）",
    "return_img": "是否返回图片结果（SQLBot 兼容命名）",
    "lang": "回答语言，如 zh / en",
    "stream": "是否流式返回结果",
    "message": "附加消息或说明",
    "url": "第三方数据接口地址",
}


def _fill_schema_desc(schema: dict[str, Any], tool_name: str) -> dict[str, Any]:
    """给 schema 的 properties 补 description（面板覆盖 > 内置字典 > 原值），
    让对外 MCP tools/list 的参数说明不为空。"""
    if not isinstance(schema, dict):
        return schema
    props = schema.get("properties") or {}
    if not props:
        return schema
    # 面板编辑的参数说明覆盖（config_kv.MCP_PARAM_DESC_OVERRIDE）
    overrides: dict[str, str] = {}
    try:
        import config_store
        raw = config_store.instance().get("MCP_PARAM_DESC_OVERRIDE", "") or ""
        overrides = json.loads(raw) if raw else {}
        if not isinstance(overrides, dict):
            overrides = {}
    except Exception:
        pass
    for pn, pdef in props.items():
        if not isinstance(pdef, dict):
            continue
        if (pdef.get("description") or "").strip():
            continue  # 上游已有说明，不覆盖
        custom = overrides.get(f"{tool_name}|{pn}") or overrides.get(pn) \
            or _PARAM_DESC_FALLBACK.get((pn or "").strip().lower(), "")
        if custom:
            pdef["description"] = custom
    return schema

import admin_panel  # 复用已加载的配置读取；延迟使用避免循环

try:
    from fastmcp import Client, FastMCP
    from fastmcp.client.transports import SSETransport
    from fastmcp.server.dependencies import get_http_request
    from fastmcp.server.middleware import Middleware, MiddlewareContext
    _IMPORT_ERR = None
except Exception as _e:  # pragma: no cover
    Client = FastMCP = SSETransport = Middleware = MiddlewareContext = None  # type: ignore
    get_http_request = None  # type: ignore
    _IMPORT_ERR = str(_e)

import voice_db

_gateway_server: Any = None       # SSE transport 的 FastMCP 实例
_stream_server: Any = None        # Streamable-HTTP transport 的 FastMCP 实例（独立实例，避免共享 lifespan 重复进入）
_upstream_tools: dict[str, dict[str, Any]] = {}   # qualified_name -> {server_id, name, description}

# 鉴权由管理员配置的发现脚本负责（mcp_servers.script），中转层不按业务类型换 token。

class _ToolACL(Middleware):
    """按 API-Key 过滤工具：tools/list 只列可见工具；tools/call 未授权则拒绝。"""

    async def on_list_tools(self, context: MiddlewareContext, call_next):
        tools = await call_next(context)
        visible = _visible_for_request()
        if visible is None:
            return tools  # 未拿到 key_id（如无鉴权调试）——不隐藏，交由上层鉴权决定
        return [t for t in tools if t.name in visible]

    async def on_call_tool(self, context: MiddlewareContext, call_next):
        name = getattr(context.message, "name", None) or (
            context.message.get("name") if isinstance(context.message, dict) else None)
        visible = _visible_for_request()
        if visible is not None and name and name not in visible:
            from fastmcp.exceptions import ToolError
            raise ToolError(f"tool not authorized for this API-Key: {name}")
        return await call_next(context)


def _visible_for_request() -> set[str] | None:
    """从当前 MCP 会话的 HTTP request 取 key_id，返回可见工具集合；取不到返回 None。"""
    if get_http_request is None:
        return None
    try:
        req = get_http_request()
        key_id = getattr(req.state, "api_key_id", None)
        if key_id is None:
            return None
        return voice_db.mcp_acl_visible_tools(int(key_id))
    except Exception:
        return None


def _parse_headers(server: dict[str, Any]) -> dict[str, str]:
    raw = server.get("headers_json") or "{}"
    try:
        d = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (ValueError, TypeError):
        d = {}
    return {str(k): str(v) for k, v in (d or {}).items() if str(v)}


async def _run_discovery_script(server: dict[str, Any], headers: dict[str, str], url: str) -> tuple[dict[str, str], str]:
    """发现工具阶段执行管理员配置的动态脚本，动态获取 token 注入 header/query。

    脚本签名：async def auth(url, headers, context) -> {'headers': dict, 'query': dict}
      - url: 网关配置的上游地址（只读，脚本基于它推导 token 接口地址）
      - headers: 当前请求头（可改）
      - context: {'server_id', 'name'}
      - 返回 query: 要追加到 URL 的查询参数（如 ?token=xxx）

    安全边界：
      - 脚本【不能改 host/path】——本函数只把返回的 query 合并到原 url，不接脚本返回的 url；
        网关地址锁死为 server 配置的 url（"必须是网关的地址"）。
      - 任何异常/超时/非法返回都兜底为原 headers + 原 url，记 last_error，不中断其它 server 发现。
    """
    script = (server.get("script") or "").strip()
    if not script:
        return headers, url
    try:
        ns: dict[str, Any] = {}
        exec(script, ns)  # 管理员在面板配置的脚本，信任级别等同工具注册时的 exec
        fn = ns.get("auth")
        if not callable(fn):
            raise ValueError("脚本未定义 auth(url, headers, context) 函数")
        context = {
            "server_id": server.get("id"),
            "name": server.get("name") or "",
        }
        result = await asyncio.wait_for(fn(url, dict(headers), context), timeout=15)
        if not isinstance(result, dict):
            raise ValueError("auth() 返回值不是 dict")

        out_headers = dict(headers)
        new_headers = result.get("headers")
        if isinstance(new_headers, dict):
            out_headers.update({str(k): str(v) for k, v in new_headers.items() if v is not None})

        # 只合并 query，URL 的 host/path 锁死为网关配置地址
        out_url = url
        query = result.get("query")
        if isinstance(query, dict) and query:
            from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
            parsed = urlparse(url)
            qs = parse_qs(parsed.query)
            for k, v in query.items():
                qs[str(k)] = [str(v)] if not isinstance(v, (list, tuple)) else [str(x) for x in v]
            out_url = urlunparse(parsed._replace(query=urlencode(qs, doseq=True)))

        voice_db.mcp_server_health(server["id"], True)  # 脚本成功不覆盖健康状态
        return out_headers, out_url
    except Exception as exc:
        voice_db.mcp_server_health(server["id"], False, f"发现脚本执行失败: {exc}"[:500])
        return headers, url  # 兜底：原 headers + 原 url


async def _make_client(server: dict[str, Any]):
    """按上游配置构造 FastMCP Client：执行脚本动态获取 token + 全远程传输（SSE / Streamable HTTP）。"""
    headers = _parse_headers(server)
    timeout = int(server.get("timeout_sec") or 30)
    from fastmcp.client.transports import SSETransport, StreamableHttpTransport
    transport = headers.pop("transport", None)
    url = server["url"]
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("MCP 上游仅支持远程 http(s) 地址（SSE / Streamable HTTP），不支持本地 stdio")
    # 发现与调用阶段都执行管理员脚本动态获取 token（上游在连接层就校验 token）。
    # 不在中转层缓存 token——py 端没有账号密码，token 由脚本自己调上游 access_token 换取；
    # 每轮工具调用都重取，天然规避 token 过期问题。
    if (server.get("script") or "").strip():
        headers, url = await _run_discovery_script(server, headers, url)
    if transport == "sse" or url.rstrip("/").endswith("/sse"):
        TK = SSETransport
    elif transport == "streamable-http":
        TK = StreamableHttpTransport
    else:
        TK = StreamableHttpTransport
    return Client(TK(url, headers=headers), timeout=timeout)


def _extract_sse_text(payload: str) -> str:
    """从单条 SSE data 载荷里提取可读文本。

    优先取常见正文/回答字段（OpenAI delta.content、Dify answer、通用 text/content），
    都不是 JSON 时原样返回，避免丢信息。
    """
    p = payload.strip()
    if not p or p == "[DONE]":
        return ""
    try:
        obj = json.loads(p)
    except (ValueError, TypeError):
        return p
    if not isinstance(obj, dict):
        return str(obj)
    # OpenAI chat.completion.chunk: choices[0].delta.content（也兼容顶层 delta）
    delta = obj.get("delta")
    if isinstance(delta, dict) and delta.get("content"):
        return str(delta["content"])
    choices = obj.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        d = choices[0].get("delta")
        if isinstance(d, dict) and d.get("content"):
            return str(d["content"])
        msg = choices[0].get("message")
        if isinstance(msg, dict) and msg.get("content"):
            return str(msg["content"])
    for key in ("answer", "text", "content", "message", "output"):
        v = obj.get(key)
        if isinstance(v, str) and v:
            return v
    # Dify workflow: data.outputs.answer
    data = obj.get("data")
    if isinstance(data, dict):
        for key in ("answer", "text", "content", "output"):
            v = data.get(key)
            if isinstance(v, str) and v:
                return v
        outputs = data.get("outputs")
        if isinstance(outputs, dict) and outputs.get("answer"):
            return str(outputs["answer"])
    # 没有已知字段：不丢信息，回退到紧凑 JSON（去掉 [DONE] 等噪声已处理）
    return json.dumps(obj, ensure_ascii=False)


async def _call_http_tool(tool: dict[str, Any], arguments: dict[str, Any]) -> str:
    """其他工具：按配置直接发 HTTP 请求（参数按 in 分发 query/header/body）。

    上游返回 text/event-stream（SSE）时，自动解析 data: 事件并提取正文，
    汇总成完整文本返回（MCP tools/call 一次性结果，不做流式透传）。
    """
    import httpx
    method = (tool.get("method") or "POST").strip().upper()
    url = (tool.get("url") or "").strip()
    try:
        # headers_json 直接保存真实值（如百度地图 api-key），调用时原样发送。
        headers = json.loads(tool.get("headers_json") or "{}") or {}
    except (ValueError, TypeError):
        headers = {}
    try:
        params_def = json.loads(tool.get("params_json") or "[]") or []
    except (ValueError, TypeError):
        params_def = []
    locations = {p.get("name"): (p.get("in") or "body") for p in params_def
                 if isinstance(p, dict) and p.get("name")}
    query, hdrs, body = {}, dict(headers), {}
    for k, v in (arguments or {}).items():
        if v is None:
            continue
        loc = locations.get(k, "body")
        if loc == "query":
            query[k] = v
        elif loc == "header":
            hdrs[k] = str(v)
        else:
            body[k] = v
    timeout = int(tool.get("timeout_sec") or 30)
    try:
        # 保留 URL 自带的 query（如高德 key），再合并工具参数；httpx 的 params= 会覆盖原有 query。
        final_url = httpx.URL(url).copy_merge_params(query) if query else httpx.URL(url)
        async with httpx.AsyncClient(timeout=timeout) as cli:
            async with cli.stream(method, final_url, headers=hdrs,
                                  json=body if body else None) as r:
                ctype = (r.headers.get("content-type") or "").lower()
                if "text/event-stream" in ctype or "application/x-ndjson" in ctype:
                    # SSE / NDJSON：逐行解析 data: 事件，提取正文汇总。
                    parts: list[str] = []
                    async for line in r.aiter_lines():
                        line = line.strip()
                        if line.startswith("data:"):
                            text = _extract_sse_text(line[5:])
                        elif "application/x-ndjson" in ctype and line:
                            text = _extract_sse_text(line)
                        else:
                            continue
                        if text:
                            parts.append(text)
                    result = "".join(parts) if parts else "(SSE 响应无正文)"
                    return f"HTTP {r.status_code} (SSE)\n{result[:4000]}"
                # 普通响应：保持原行为。
                raw = await r.aread()
                return f"HTTP {r.status_code}\n{raw.decode('utf-8', 'replace')[:4000]}"
    except Exception as exc:
        return f"[mcp-gateway] http tool failed: {exc}"


async def _call_upstream(qualified_name: str, arguments: dict[str, Any]) -> Any:
    """按 qualified_name 找上游并转发 tools/call；失败返回错误字符串（MCP tool 结果）。"""
    meta = _upstream_tools.get(qualified_name)
    if not meta:
        return f"[mcp-gateway] unknown tool: {qualified_name}"
    # server_id=0 → 其他工具（直接 HTTP 调用）
    if meta["server_id"] == 0:
        tool = voice_db.mcp_http_tool_get_by_name(meta["name"])
        if not tool or not tool.get("enabled"):
            return f"[mcp-gateway] http tool unavailable: {meta['name']}"
        return await _call_http_tool(tool, arguments)
    server = voice_db.mcp_server_get(meta["server_id"])
    if not server or not server.get("enabled"):
        return f"[mcp-gateway] upstream unavailable: {meta['server_id']}"
    try:
        async with await _make_client(server) as client:
            result = await client.call_tool(meta["name"], arguments or {}, raise_on_error=False)
        # CallToolResult -> 便于阅读的字符串（保留结构化 content）
        texts = []
        for block in getattr(result, "content", []) or []:
            t = getattr(block, "text", None)
            if t is not None:
                texts.append(t)
            else:
                texts.append(str(block))
        return "\n".join(texts) if texts else str(result)
    except Exception as exc:
        voice_db.mcp_server_health(meta["server_id"], False, str(exc)[:500])
        return f"[mcp-gateway] upstream call failed: {exc}"


async def refresh() -> dict[str, Any]:
    """重连所有 enabled 上游，发现工具并注册；返回统计。"""
    global _upstream_tools, _gateway_server, _stream_server
    if FastMCP is None:
        return {"error": f"mcp SDK unavailable: {_IMPORT_ERR}"}
    _upstream_tools = {}
    all_servers = voice_db.mcp_servers_list()
    servers = [s for s in all_servers if s.get("enabled")]
    # 清理已删除或被禁用 server 的缓存（避免它们的工具永远留在清单里）
    live_ids = {s["id"] for s in servers}
    conn = voice_db._conn_get()
    cached_ids = {r[0] for r in conn.execute(
        "SELECT DISTINCT server_id FROM mcp_discovered_tools").fetchall()}
    for dead_sid in cached_ids - live_ids:
        conn.execute("DELETE FROM mcp_discovered_tools WHERE server_id=?", (dead_sid,))
    conn.commit()
    discovered: list[tuple[str, str, int, str, dict]] = []  # (qualified, orig, sid, desc, schema)
    failed: set[int] = set()
    for s in servers:
        try:
            # 发现工具时才执行管理员脚本动态获取 token；tools/call 不执行
            async with await _make_client(s) as client:
                tools = await client.list_tools()
            fresh: list[dict[str, Any]] = []
            for t in tools:
                prefix = (s.get('tool_prefix') or '').strip() or s['name']
                # 工具前缀规范化：只允许 [A-Za-z0-9_.-]，避免中文网关名产生非法工具名
                import re as _re
                prefix = _re.sub(r'[^A-Za-z0-9_.-]', '_', prefix)
                q = f"{prefix}__{t.name}"
                # MCP SDK v2 将 inputSchema 重命名为 input_schema；优先读新字段，兼容旧版回退。
                schema = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {}
                schema = _fill_schema_desc(schema, t.name)
                discovered.append((q, t.name, s["id"], getattr(t, "description", "") or "", schema))
                fresh.append({"qualified_name": q, "orig_name": t.name,
                              "description": getattr(t, "description", "") or "",
                              "input_schema": schema})
            # 发现成功：原子替换该 server 的工具缓存（v26）
            voice_db.mcp_discovered_replace_server(s["id"], fresh)
            voice_db.mcp_server_health(s["id"], True)
        except Exception as exc:
            failed.add(s["id"])
            voice_db.mcp_server_health(s["id"], False, str(exc)[:500])
            # 发现失败：保留上次缓存的工具，让工具仍在对外清单（调用时才报上游不可用）
            for cached in voice_db.mcp_discovered_by_server(s["id"]):
                discovered.append((cached["qualified_name"], cached["orig_name"], s["id"],
                                   cached["description"], cached["input_schema"]))
    # 其他工具（直接 HTTP 调用）：走内置 default 网关，server_id=0 标记。
    for t in voice_db.mcp_http_tools_list():
        if not t.get("enabled"):
            continue
        try:
            params = json.loads(t.get("params_json") or "[]") or []
        except (ValueError, TypeError):
            params = []
        props, required = {}, []
        for p in params:
            if not isinstance(p, dict) or not p.get("name"):
                continue
            props[p["name"]] = {"type": p.get("type") or "string",
                                "description": p.get("description") or ""}
            if p.get("required"):
                required.append(p["name"])
        schema = {"type": "object", "properties": props, "required": required}
        discovered.append((f"default__{t['name']}", t["name"], 0,
                           t.get("description") or "", schema))
    # 清理失效工具授权：用 DB 缓存的全部工具名（含失败 server 的旧缓存），
    # 避免上游临时挂掉时把授权也清掉。
    voice_db.mcp_acl_prune(voice_db.mcp_discovered_names() | {d[0] for d in discovered})
    # 构建 FastMCP Server。对外同时提供 SSE 与 Streamable-HTTP 两种 transport，
    # 但必须用两个独立实例：同一实例的多个 http_app 会各自进入 server lifespan，
    # 造成 FastMCP 源码明确警告的 double-stack。工具在两个实例上各注册一份。
    def _register_tools(server):
        registered = []
        for q, orig, sid, desc, schema in discovered:
            # FastMCP 从函数签名生成 inputSchema，不接受 **kwargs；
            # 按上游 inputSchema 动态生成固定签名函数，每个参数透传给 _call_upstream。
            props = (schema or {}).get("properties", {}) or {}
            required = set((schema or {}).get("required", []) or [])
            params = []
            seen = set()
            for pn in props.keys():
                safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in pn)
                if not safe or safe[0].isdigit():
                    safe = "_" + safe
                while safe in seen:
                    safe = safe + "_" + str(len(seen))
                seen.add(safe)
                params.append((pn, safe, pn not in required))
            # Python 签名不允许「有默认值参数」出现在「必填参数」之前，
            # 上游 properties 顺序不保证 required 在前，这里强制 required 优先。
            params.sort(key=lambda x: x[2])
            # 生成带类型注解 + Field 描述的签名，让 FastMCP 推断出正确的
            # 参数类型与说明（否则客户端看到的类型都是 any、说明为空）。
            type_map = {"string": "str", "integer": "int", "number": "float",
                        "boolean": "bool", "array": "list", "object": "dict"}
            sig_parts = []
            for pn, sp, opt in params:
                pdef = props.get(pn) or {}
                ptype = type_map.get((pdef.get("type") or "string").lower(), "str")
                pdesc = (pdef.get("description") or "").replace('"', '\\"')
                ann = f'Annotated[{ptype}, Field(description="{pdesc}")]'
                sig_parts.append(f"{sp}: {ann}" + (" = None" if opt else ""))
            sig = ", ".join(sig_parts)
            argmap = "{" + ", ".join(f'"{orig_p}": {sp}' for orig_p, sp, _ in params) + "}"
            fn_name = q.replace("__", "_").replace("-", "_")
            src = (f"async def {fn_name}({sig}):\n"
                   f"    return await __call_upstream({q!r}, {argmap})\n")
            from typing import Annotated, Any
            from pydantic import Field
            ns = {"__call_upstream": _call_upstream, "Annotated": Annotated,
                  "Field": Field, "str": str, "int": int, "float": float,
                  "bool": bool, "list": list, "dict": dict, "Any": Any}
            try:
                exec(src, ns)
                fn = ns[fn_name]
                fn.__doc__ = desc or f"forward to upstream {orig}"
                server.tool(name=q, description=desc or None)(fn)
                registered.append((q, orig, sid, desc))
            except Exception as exc:
                # 极端参数名导致生成失败：跳过该工具，不影响其它；但必须留痕便于排查
                print(f"[mcp-gateway] 注册工具 {q} 失败：{exc}", flush=True)
        server.add_middleware(_ToolACL())
        return registered

    sse_server = FastMCP("app-product-gateway-sse")
    http_server = FastMCP("app-product-gateway-http")
    registered = _register_tools(sse_server)      # 以 SSE 实例的注册结果为准（两实例逻辑相同）
    _register_tools(http_server)
    for q, orig, sid, desc, schema in discovered:
        # 带上 inputSchema，供管理面板「工具」页展开查看参数说明。
        _upstream_tools[q] = {"server_id": sid, "name": orig, "description": desc,
                              "input_schema": schema or {}}
    _gateway_server = sse_server
    _stream_server = http_server
    return {"servers": len(servers), "tools": len(registered),
            "failed_servers": sorted(failed)}


def get_server() -> Any:
    return _gateway_server


def _build_auth_wrapper():
    """返回 Starlette 中间件类：在 mount 的子 app 内做 API-Key 鉴权并写 request.state.api_key_id。

    主 app 的 security_middleware 不覆盖 mount 子 app，故 /mcp 需自带鉴权，
    与 openai_voice_server 的 /llm /voice 同口径（复用 voice_db.api_keys_verify）。
    """
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    class MCPAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            # 复用主服务鉴权开关；关闭时不强制（方便本地调试），开启时必须带有效 key
            try:
                import openai_voice_server as ovs
                enabled = ovs.api_key_auth_enabled()
                ip = ovs.client_ip(request)
            except Exception:
                enabled, ip = False, ""
            if request.method != "OPTIONS" and enabled:
                header = request.headers.get("authorization") or ""
                token = header[7:].strip() if header.lower().startswith("bearer ") else ""
                matched = voice_db.api_keys_verify(token, ip) if token else None
                if not matched:
                    return JSONResponse(status_code=401, content={"detail": "缺少或错误的 API Key"},
                                        headers={"WWW-Authenticate": "Bearer"})
                request.state.api_key_id = matched["id"]
                request.state.api_key_name = matched["name"]
            return await call_next(request)
    return MCPAuth


def sse_app():
    """返回挂到 FastAPI /mcp 的组合 ASGI app：同时支持 SSE 与 Streamable-HTTP，自带 API-Key 鉴权。

    对外路径（mount 前缀 /mcp）：
      - SSE：GET  /mcp/sse          握手；POST /mcp/messages/  通信
      - Streamable-HTTP：/mcp/      （POST initialize / tools/list / tools/call，GET/DELETE 会话）
    两种 transport 用两个独立 FastMCP 实例（refresh 里构建），这里组合成一个 app：
    父 Starlette 分别驱动两个子 app 的 lifespan，HTTP 请求按路径前缀分发。
    """
    if _gateway_server is None or _stream_server is None:
        return None
    auth = _build_auth_wrapper()
    # SSE: 内部路由 /sse 握手 + /messages 消息端点
    sse_sub = _gateway_server.http_app(path="/sse", transport="sse")
    # Streamable: 根路径单端点（/mcp/），标准 FastMCP 客户端默认即连根
    stream_sub = _stream_server.http_app(path="/", transport="streamable-http")
    sse_sub.add_middleware(auth)
    stream_sub.add_middleware(auth)

    class _ComboApp:
        """纯 ASGI 分发器：按 path 前缀把请求转给对应子 app，保留原始 scope。

        - /sse、/messages…         → SSE 子 app
        - 其余（含 / 根）          → Streamable-HTTP 子 app
        lifespan 由本类手动驱动两个子 app 各一次（两个独立实例，互不冲突）。
        """

        def __init__(self, sse, stream):
            self.sse = sse
            self.stream = stream

        @asynccontextmanager
        async def lifespan_context(self):
            """供父 FastAPI 在自身 lifespan 里显式驱动（mount 的子 app 收不到 lifespan）。"""
            async with AsyncExitStack() as stack:
                await stack.enter_async_context(self.sse.router.lifespan_context(self.sse))
                await stack.enter_async_context(self.stream.router.lifespan_context(self.stream))
                yield

        async def __call__(self, scope, receive, send):
            if scope["type"] == "lifespan":
                # 兜底：若被当作普通 ASGI 应用驱动 lifespan，走标准 ASGI 握手
                msg = await receive()
                if msg["type"] != "lifespan.startup":
                    return
                ctx = self.lifespan_context()
                try:
                    await ctx.__aenter__()
                except Exception as exc:
                    await send({"type": "lifespan.startup.failed", "message": str(exc)})
                    return
                await send({"type": "lifespan.startup.complete"})
                msg = await receive()
                if msg["type"] == "lifespan.shutdown":
                    await ctx.__aexit__(None, None, None)
                    await send({"type": "lifespan.shutdown.complete"})
                return
            # mount 后 scope["path"] 仍是完整路径（/mcp/sse），root_path 才是 /mcp。
            # 子 app 内部路由按去掉前缀的相对路径匹配，故这里用相对路径判断分发。
            path = scope.get("path", "")
            root = scope.get("root_path", "") or ""
            rel = path[len(root):] if root and path.startswith(root) else path
            if rel == "/sse" or rel.startswith("/messages"):
                await self.sse(scope, receive, send)
            else:
                await self.stream(scope, receive, send)

    return _ComboApp(sse_sub, stream_sub)
