"""MCP server 中转网关：对外暴露 MCP（FastMCP），聚合上游 MCP server 工具并转发。

- 对外：FastMCP Server 挂到现有 FastAPI /mcp（SSE），每个工具的 list/call 按 API-Key
  (request.state.api_key_id) 过滤——见 _ToolACL middleware。
- 上游：mcp_servers 表配置，FastMCP Client(SSETransport) 连接，工具自动发现并加 <name>__ 前缀。
- 鉴权：复用 openai_voice_server 的 security_middleware（/mcp* 非白名单天然需 API-Key）。
- 依赖：langchain[mcp]（含 fastmcp + mcp SDK）；import 失败时上层返回 501，不影响主服务。
"""
from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager, AsyncExitStack
from typing import Any
from urllib.parse import urlparse

import httpx

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

# ── 业务类型规则 ────────────────────────────────────────────────────
# 每个业务类型可定义自己的鉴权准备逻辑：在连上游前把账号密码换成 token 注入 headers。
# generic: 静态 headers（headers_json 里有什么就用什么）
# askdata: 用账号密码调上游 /api/v1/mcp/access_token 换 X-SQLBOT-TOKEN，带缓存
BIZ_RULES: dict[str, dict[str, Any]] = {
    "generic": {"auth": "static"},
    "askdata": {
        "auth": "token_exchange",
        "token_path": "/api/v1/mcp/access_token",
        "token_header": "X-SQLBOT-TOKEN",
        "ttl_sec": 7 * 24 * 3600,   # sa-token 有效期约 8 天，提前 1 天过期重换
    },
}
_token_cache: dict[tuple, tuple[str, float]] = {}   # (server_id, key_id, user) -> (token, expire_ts)



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


def _current_key_id() -> int | None:
    """当前 MCP 会话的 API-Key id（用于按 Key 取账号密码）。"""
    if get_http_request is None:
        return None
    try:
        req = get_http_request()
        kid = getattr(req.state, "api_key_id", None)
        return int(kid) if kid is not None else None
    except Exception:
        return None


def _askdata_credentials(key_id: int | None) -> tuple[str, str]:
    """取 askdata 账号密码：优先 API-Key 自带字段，否则网关默认值。"""
    user = pwd = ""
    if key_id:
        row = voice_db._conn_get().execute(
            "SELECT askdata_user, askdata_pass FROM admin_api_keys WHERE id=?", (key_id,)
        ).fetchone()
        if row:
            user, pwd = row["askdata_user"] or "", row["askdata_pass"] or ""
    if not user or not pwd:
        try:
            import openai_voice_server as ovs
            user = user or (ovs.config_value("MCP_ASKDATA_USER", "") or "")
            pwd = pwd or (ovs.config_value("MCP_ASKDATA_PASS", "") or "")
        except Exception:
            pass
    return user, pwd


async def _prepare_auth(server: dict[str, Any], headers: dict[str, str], key_id: int | None) -> dict[str, str]:
    """按业务类型准备鉴权 headers。askdata 用账号密码动态换 token（带缓存）。"""
    biz = (server.get("biz_type") or "generic").strip().lower()
    rule = BIZ_RULES.get(biz, BIZ_RULES["generic"])
    if rule["auth"] != "token_exchange":
        return headers
    user, pwd = _askdata_credentials(key_id)
    if not user or not pwd:
        raise ValueError(f"业务 {biz} 需要账号密码：请在 API-Key 或网关默认配置 MCP_ASKDATA_USER/PASS")
    cache_key = (server.get("id"), key_id, user)
    now = time.time()
    cached = _token_cache.get(cache_key)
    if cached and cached[1] > now + 60:
        headers[rule["token_header"]] = cached[0]
        return headers
    url = server["url"]
    parsed = urlparse(url)
    token_url = f"{parsed.scheme}://{parsed.netloc}{rule['token_path']}"
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.post(token_url, json={"username": user, "password": pwd})
        data = r.json() if r.status_code == 200 else {}
        token = data.get("token") or data.get("access_token") or ""
        if not token:
            raise ValueError(f"换取 token 失败: HTTP {r.status_code} {r.text[:120]}")
        _token_cache[cache_key] = (token, now + rule["ttl_sec"])
        headers[rule["token_header"]] = token
        return headers
    except httpx.HTTPError as exc:
        raise ValueError(f"换取 token 请求失败: {exc}")


async def _make_client(server: dict[str, Any]):
    """按上游配置构造 FastMCP Client：业务类型鉴权 + 全远程传输（SSE / Streamable HTTP）。"""
    headers = _parse_headers(server)
    timeout = int(server.get("timeout_sec") or 30)
    from fastmcp.client.transports import SSETransport, StreamableHttpTransport
    transport = headers.pop("transport", None)
    url = server["url"]
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("MCP 上游仅支持远程 http(s) 地址（SSE / Streamable HTTP），不支持本地 stdio")
    headers = await _prepare_auth(server, headers, _current_key_id())
    if transport == "sse" or url.rstrip("/").endswith("/sse"):
        TK = SSETransport
    elif transport == "streamable-http":
        TK = StreamableHttpTransport
    else:
        TK = StreamableHttpTransport
    return Client(TK(url, headers=headers), timeout=timeout)


async def _call_http_tool(tool: dict[str, Any], arguments: dict[str, Any]) -> str:
    """其他工具：按配置直接发 HTTP 请求（参数按 in 分发 query/header/body）。"""
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
        async with httpx.AsyncClient(timeout=timeout) as cli:
            r = await cli.request(method, url, params=query or None,
                                  headers=hdrs, json=body if body else None)
        return f"HTTP {r.status_code}\n{r.text[:4000]}"
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
    servers = [s for s in voice_db.mcp_servers_list() if s.get("enabled")]
    discovered: list[tuple[str, str, int, str, dict]] = []  # (qualified, orig, sid, desc, schema)
    failed: set[int] = set()
    for s in servers:
        try:
            async with await _make_client(s) as client:
                tools = await client.list_tools()
            for t in tools:
                prefix = (s.get('tool_prefix') or '').strip() or s['name']
                # 工具前缀规范化：只允许 [A-Za-z0-9_.-]，避免中文网关名产生非法工具名
                import re as _re
                prefix = _re.sub(r'[^A-Za-z0-9_.-]', '_', prefix)
                q = f"{prefix}__{t.name}"
                # MCP SDK v2 将 inputSchema 重命名为 input_schema；优先读新字段，兼容旧版回退。
                schema = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {}
                discovered.append((q, t.name, s["id"], getattr(t, "description", "") or "", schema))
            voice_db.mcp_server_health(s["id"], True)
        except Exception as exc:
            failed.add(s["id"])
            voice_db.mcp_server_health(s["id"], False, str(exc)[:500])
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
    # 清理失效工具授权
    voice_db.mcp_acl_prune({d[0] for d in discovered})
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
            # 生成源码：async def _fn(param1, param2=None, ...): return await _call_upstream(q, {...})
            sig = ", ".join(f"{sp}=None" if opt else sp for _, sp, opt in params)
            argmap = "{" + ", ".join(f'"{orig_p}": {sp}' for orig_p, sp, _ in params) + "}"
            fn_name = q.replace("__", "_").replace("-", "_")
            src = (f"async def {fn_name}({sig}):\n"
                   f"    return await __call_upstream({q!r}, {argmap})\n")
            ns = {"__call_upstream": _call_upstream}
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
