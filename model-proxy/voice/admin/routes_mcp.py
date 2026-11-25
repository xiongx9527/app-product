"""管理面板路由 · MCP 中转网关域：上游 CRUD / 工具授权 / 重连。

由 admin_panel.register_admin_routes 在运行时加载。
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends

import admin_panel as ap
import voice_db


# 内置 default 网关前缀（其他工具专用），其他网关禁止占用。
DEFAULT_TOOL_PREFIX = "default"

# 参数位置推断：MCP 的 inputSchema 本身不标注 header/body/query，按参数名模式推断，
# 仅用于管理面板展示（真实调用所有参数都作为 JSON body 透传给上游）。
_HEADER_NAMES = {"authorization", "token", "access_token", "api_key", "apikey",
                 "x-api-key", "content-type", "accept", "cookie", "session"}
_QUERY_NAMES = {"page", "page_size", "pagesize", "limit", "offset", "q", "keyword",
                "sort", "order", "filter", "since", "cursor", "workspaceid", "datasourceid"}


def _param_location(name: str) -> str:
    n = (name or "").strip().lower()
    if n in _HEADER_NAMES or n.startswith("x-"):
        return "header"
    if n in _QUERY_NAMES:
        return "query"
    return "body"


# 上游 inputSchema 通常不带参数描述；按参数名补一份中文说明（来自问数 MCP 源码语义）。
_PARAM_DESC: dict[str, str] = {
    "token": "访问令牌（SQLBot 兼容，兼容工具可传；主通道由网关自动注入）",
    "authorization": "第三方鉴权头（Bearer token）",
    "username": "用户名（用于换取访问 token）",
    "password": "密码（用于换取访问 token）",
    "oid": "组织/工作空间 ID",
    "workspaceid": "工作空间 ID（管理员可指定，默认当前工作空间）",
    "datasourceid": "数据源 ID（选定后只查该数据源）",
    "datasource_id": "数据源 ID（兼容 SQLBot 命名，可为对象）",
    "chatid": "会话 ID（续接已有问数会话并落库）",
    "chat_id": "会话 ID（兼容 SQLBot 命名）",
    "question": "自然语言问题（问数输入）",
    "custommodel": "按次指定对话模型 ID",
    "custom_model": "按次指定对话模型（兼容 SQLBot 命名）",
    "returnimg": "是否返回图片（true=出图，默认 true）",
    "return_img": "是否返回图片（兼容 SQLBot 命名）",
    "lang": "回答语言（如 zh / en）",
    "stream": "是否流式返回",
    "message": "附加消息/说明",
    "url": "第三方数据接口地址",
}


def _param_desc_overrides() -> dict[str, str]:
    """面板编辑的参数说明覆盖：config_kv 的 MCP_PARAM_DESC_OVERRIDE（JSON）。"""
    try:
        import config_store
        raw = config_store.instance().get("MCP_PARAM_DESC_OVERRIDE", "") or ""
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _param_desc(name: str, fallback: str, tool: str = "", overrides: dict[str, str] | None = None) -> str:
    # 优先级：面板覆盖 > 上游 description > 内置字典
    if overrides and tool:
        custom = overrides.get(f"{tool}|{name}") or overrides.get(name)
        if custom:
            return custom
    return (fallback or "").strip() or _PARAM_DESC.get((name or "").strip().lower(), "")


def _build_params(schema: dict[str, Any], biz_type: str = "", tool: str = "") -> list[dict[str, Any]]:
    """从 inputSchema 构造展示用参数列表；askdata 类补一行网关自动注入的鉴权头。"""
    schema = schema or {}
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    overrides = _param_desc_overrides()
    params: list[dict[str, Any]] = []
    for pn, pp in props.items():
        if not isinstance(pp, dict):
            pp = {}
        params.append({"name": pn, "type": pp.get("type") or "string",
                       "required": pn in required, "in": _param_location(pn),
                       "description": _param_desc(pn, pp.get("description") or "", tool, overrides),
                       "auto": False})
    # askdata 网关用账号密码换 token 并注入 X-SQLBOT-TOKEN，上游 schema 通常不声明，
    # 面板补一行让用户知道该工具的鉴权来源（非用户填写参数）。
    if (biz_type or "").strip().lower() == "askdata":
        has_auth = any(p["name"].lower() in {"token", "authorization", "x-sqlbot-token"}
                       for p in params)
        if not has_auth:
            params.append({"name": "X-SQLBOT-TOKEN", "type": "string", "required": True,
                           "in": "header", "description": "网关自动注入（账号密码换取，无需填写）",
                           "auto": True})
    return params


def build_router() -> APIRouter:
    router = APIRouter()
    require_admin = ap.require_admin

    def _mask_headers(raw: str) -> str:
        """脱敏 headers_json：值用 •••• 代替，避免明文回传（编辑时不覆盖）。"""
        import json
        try:
            d = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            d = {}
        return json.dumps({k: ("••••••" if v else "") for k, v in (d or {}).items()},
                          ensure_ascii=False)

    @router.get("/admin/api/mcp/servers", dependencies=[Depends(require_admin)])
    def mcp_servers_list():
        rows = voice_db.mcp_servers_list()
        import json as _json
        for r in rows:
            raw = r.get("headers_json") or "{}"
            # 传输协议：显式 transport 优先，否则按 URL 推断（/sse 结尾=SSE，其余 Streamable HTTP）
            try:
                cfg = _json.loads(raw) if isinstance(raw, str) else dict(raw)
            except (ValueError, TypeError):
                cfg = {}
            t = (cfg.get("transport") or "").strip().lower()
            if not t or t == "auto":
                t = "sse" if (r.get("url") or "").rstrip("/").endswith("/sse") else "streamable-http"
            r["transport"] = t
            r["headers_json"] = _mask_headers(raw)
        return {"servers": rows}

    @router.post("/admin/api/mcp/servers", dependencies=[Depends(require_admin)])
    def mcp_server_add(body: dict[str, Any]):
        from fastapi import HTTPException
        name = str(body.get("name") or "").strip()
        url = str(body.get("url") or "").strip()
        biz = str(body.get("biz_type") or "generic").strip() or "generic"
        if not name or not url:
            raise HTTPException(400, "name 和 url 必填")
        # 非 generic 业务类型（如 askdata）只允许一个——避免重复换 token / 重复聚合
        if biz != "generic":
            for s in voice_db.mcp_servers_list():
                if (s.get("biz_type") or "generic") == biz:
                    raise HTTPException(400, f"业务类型 {biz} 已存在，只能添加一个")
        prefix = str(body.get("tool_prefix") or "").strip()
        if prefix.lower() == DEFAULT_TOOL_PREFIX:
            raise HTTPException(400, f"工具前缀 {DEFAULT_TOOL_PREFIX} 为其他工具专用，不能用于网关")
        if prefix:
            for s in voice_db.mcp_servers_list():
                if (s.get("tool_prefix") or "") == prefix:
                    raise HTTPException(400, f"工具前缀 {prefix} 已存在，不能重复")
        try:
            voice_db.mcp_server_add(name, url, body.get("headers_json") or "{}",
                                    int(body.get("enabled", 1)), int(body.get("timeout_sec") or 30),
                                    biz_type=biz, tool_prefix=prefix)
        except Exception as exc:
            raise HTTPException(400, f"新增失败（name 重复？）: {exc}")
        return {"ok": True}

    @router.patch("/admin/api/mcp/servers/{sid}", dependencies=[Depends(require_admin)])
    def mcp_server_update(sid: int, body: dict[str, Any]):
        from fastapi import HTTPException
        fields = {k: body[k] for k in ("name", "url", "headers_json", "enabled", "timeout_sec", "biz_type", "tool_prefix") if k in body}
        if not voice_db.mcp_server_get(sid):
            raise HTTPException(404, "上游不存在")
        if str(fields.get("tool_prefix") or "").strip().lower() == DEFAULT_TOOL_PREFIX:
            raise HTTPException(400, f"工具前缀 {DEFAULT_TOOL_PREFIX} 为其他工具专用，不能用于网关")
        voice_db.mcp_server_update(sid, fields)
        return {"ok": True}

    @router.delete("/admin/api/mcp/servers/{sid}", dependencies=[Depends(require_admin)])
    def mcp_server_delete(sid: int):
        if voice_db.mcp_server_has_tools(sid):
            return {"ok": False, "reason": "该网关的工具已加入对外清单，请先移除工具再删除"}
        voice_db.mcp_server_delete(sid)
        return {"ok": True}

    # ── 其他工具（HTTP 调用，走 default 网关）──────────────────────
    @router.get("/admin/api/mcp/http-tools", dependencies=[Depends(require_admin)])
    def mcp_http_tools_list():
        rows = voice_db.mcp_http_tools_list()
        # headers_json 脱敏：值用 •••• 代替，避免 api-key 明文回传；编辑时原样保留。
        import json as _json
        for r in rows:
            try:
                d = _json.loads(r.get("headers_json") or "{}") or {}
            except (ValueError, TypeError):
                d = {}
            r["headers_json"] = _json.dumps(
                {k: ("••••••" if v else "") for k, v in d.items()}, ensure_ascii=False)
        return {"tools": rows}

    @router.post("/admin/api/mcp/http-tools", dependencies=[Depends(require_admin)])
    def mcp_http_tool_add(body: dict[str, Any]):
        from fastapi import HTTPException
        name = str(body.get("name") or "").strip()
        url = str(body.get("url") or "").strip()
        if not name or not url:
            raise HTTPException(400, "name 和 url 必填")
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "url 必须是 http(s) 地址")
        if voice_db.mcp_http_tool_get_by_name(name):
            raise HTTPException(400, f"工具名 {name} 已存在")
        try:
            json.loads(body.get("headers_json") or "{}")
            json.loads(body.get("params_json") or "[]")
        except (ValueError, TypeError):
            raise HTTPException(400, "headers_json / params_json 不是合法 JSON")
        voice_db.mcp_http_tool_add(
            name, url, str(body.get("description") or ""),
            str(body.get("method") or "POST"), body.get("headers_json") or "{}",
            body.get("params_json") or "[]", int(body.get("enabled", 1)),
            int(body.get("timeout_sec") or 30))
        return {"ok": True}

    @router.patch("/admin/api/mcp/http-tools/{tid}", dependencies=[Depends(require_admin)])
    def mcp_http_tool_update(tid: int, body: dict[str, Any]):
        from fastapi import HTTPException
        if not voice_db.mcp_http_tool_get(tid):
            raise HTTPException(404, "工具不存在")
        fields = {k: body[k] for k in ("name", "description", "url", "method", "headers_json",
                                       "params_json", "enabled", "timeout_sec") if k in body}
        for key in ("headers_json", "params_json"):
            if key in fields:
                try:
                    json.loads(fields[key] or ("{}" if key == "headers_json" else "[]"))
                except (ValueError, TypeError):
                    raise HTTPException(400, f"{key} 不是合法 JSON")
        # headers 脱敏值（••••••）表示未改动：保留数据库里的真实 api-key。
        if "headers_json" in fields and "••••••" in fields["headers_json"]:
            old = voice_db.mcp_http_tool_get(tid) or {}
            fields["headers_json"] = old.get("headers_json") or "{}"
        voice_db.mcp_http_tool_update(tid, fields)
        return {"ok": True}

    @router.delete("/admin/api/mcp/http-tools/{tid}", dependencies=[Depends(require_admin)])
    def mcp_http_tool_delete(tid: int):
        voice_db.mcp_http_tool_delete(tid)
        return {"ok": True}

    @router.post("/admin/api/mcp/http-tools/{tid}/test", dependencies=[Depends(require_admin)])
    async def mcp_http_tool_test(tid: int, body: dict[str, Any] | None = None):
        """测试一个 HTTP 工具：按参数定义构造示例入参，真实调用一次并返回结果。"""
        from fastapi import HTTPException
        tool = voice_db.mcp_http_tool_get(tid)
        if not tool:
            raise HTTPException(404, "工具不存在")
        import mcp_gateway
        args = (body or {}).get("args") or {}
        result = await mcp_gateway._call_http_tool(tool, args)
        return {"ok": True, "result": str(result)[:4000]}

    @router.post("/admin/api/mcp/servers/{sid}/enable", dependencies=[Depends(require_admin)])
    async def mcp_server_enable(sid: int):
        """启用网关：必须先测试连接+发现工具成功，测试不通过不允许启用。"""
        s = voice_db.mcp_server_get(sid)
        if not s:
            from fastapi import HTTPException
            raise HTTPException(404, "上游不存在")
        import mcp_gateway
        try:
            async with await mcp_gateway._make_client(s) as client:
                tools = await client.list_tools()
        except Exception as exc:
            return {"ok": False, "reason": f"测试未通过，不能启用：{str(exc)[:200]}"}
        voice_db.mcp_server_update(sid, {"enabled": 1})
        voice_db.mcp_server_health(sid, True)
        return {"ok": True, "tools": len(tools)}

    @router.get("/admin/api/mcp/tools", dependencies=[Depends(require_admin)])
    def mcp_tools():
        """当前发现的工具（qualified_name -> 描述），供面板勾选默认工具/Key 专属工具。"""
        import mcp_gateway
        tools = {}
        overrides = _param_desc_overrides()
        for q, meta in (mcp_gateway._upstream_tools or {}).items():
            srv = voice_db.mcp_server_get(meta["server_id"]) or {}
            schema = meta.get("input_schema") or {}
            orig = meta.get("name") or ""
            params = _build_params(schema, srv.get("biz_type") or "", orig)
            # 工具说明覆盖（面板编辑）：key = 原始工具名|__desc__
            desc = overrides.get(f"{orig}|__desc__") or (meta.get("description") or "")
            tools[q] = {"server_id": meta["server_id"], "name": orig,
                        "server": srv.get("name") or "", "description": desc,
                        "input_schema": schema, "params": params}
        return {"tools": tools}

    @router.get("/admin/api/mcp/acl", dependencies=[Depends(require_admin)])
    def mcp_acl_list(key_id: int | None = None):
        return {"rules": voice_db.mcp_acl_list(key_id)}

    @router.put("/admin/api/mcp/acl/{key_id}", dependencies=[Depends(require_admin)])
    def mcp_acl_set(key_id: int, body: dict[str, Any]):
        voice_db.mcp_acl_set(key_id, body.get("tools") or [])
        return {"ok": True}

    @router.get("/admin/api/mcp/defaults", dependencies=[Depends(require_admin)])
    def mcp_defaults():
        """网关级 askdata 默认账号密码（脱敏：只回 user，不回 pass）。"""
        return {"user": voice_db.get_config("MCP_ASKDATA_USER", "") or "",
                "pass_set": bool(voice_db.get_config("MCP_ASKDATA_PASS", ""))}

    @router.put("/admin/api/mcp/defaults", dependencies=[Depends(require_admin)])
    def mcp_defaults_set(body: dict[str, Any]):
        """保存网关级 askdata 默认账号密码。pass 留空=不修改。"""
        import config_store
        cs = config_store.instance()
        if "user" in body:
            cs.set("MCP_ASKDATA_USER", str(body["user"] or ""))
        if body.get("pass"):
            cs.set("MCP_ASKDATA_PASS", str(body["pass"]))
        return {"ok": True}

    @router.post("/admin/api/mcp/test", dependencies=[Depends(require_admin)])
    async def mcp_test():
        """测试网关：逐个连接 enabled 上游并 list_tools，返回每个上游的工具数/错误（不注册、不改状态）。"""
        import mcp_gateway
        results = []
        for s in voice_db.mcp_servers_list():
            if not s.get("enabled"):
                continue
            try:
                async with await mcp_gateway._make_client(s) as client:
                    tools = await client.list_tools()
                results.append({"id": s["id"], "name": s["name"], "biz_type": s.get("biz_type") or "generic",
                                "url": s["url"], "ok": True, "tools": [t.name for t in tools]})
            except Exception as exc:
                results.append({"id": s["id"], "name": s["name"], "biz_type": s.get("biz_type") or "generic",
                                "url": s["url"], "ok": False, "error": str(exc)[:300]})
        return {"results": results}

    @router.post("/admin/api/mcp/test-one", dependencies=[Depends(require_admin)])
    async def mcp_test_one(body: dict[str, Any]):
        """用临时配置（未保存的表单值）测试一个网关：连接 + list_tools，返回工具列表。

        不落库、不改健康状态。askdata 类型若没带 token 但配了账号密码，会动态换取。
        """
        import mcp_gateway
        tmp = {"id": 0, "name": str(body.get("name") or "test"), "url": str(body.get("url") or ""),
               "headers_json": body.get("headers_json") or "{}",
               "biz_type": body.get("biz_type") or "generic", "timeout_sec": int(body.get("timeout_sec") or 30)}
        if not tmp["url"].lower().startswith(("http://", "https://")):
            return {"ok": False, "error": "URL 必须是 http(s) 地址"}
        try:
            async with await mcp_gateway._make_client(tmp) as client:
                tools = await client.list_tools()
            out_tools = []
            for t in tools:
                schema = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {}
                params = _build_params(schema, tmp.get("biz_type") or "", t.name)
                out_tools.append({"name": t.name, "description": getattr(t, "description", "") or "",
                                  "params": params})
            return {"ok": True, "tools": out_tools}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}

    @router.put("/admin/api/mcp/param-desc", dependencies=[Depends(require_admin)])
    async def mcp_param_desc_set(body: dict[str, Any]):
        """面板编辑已授权 MCP 工具的说明 / 参数说明：写 config_kv.MCP_PARAM_DESC_OVERRIDE。

        body: {tool, param?, description}。
          - param 为空 → 编辑工具说明（key = "{tool}|__desc__"）
          - param 非空 → 编辑该参数说明（key = "{tool}|{param}"）
        description 为空则删除该条覆盖。tool 用原始工具名（不带网关前缀）。
        操作记入审计。
        """
        import config_store
        tool = str(body.get("tool") or "").strip()
        param = str(body.get("param") or "").strip()
        description = str(body.get("description") or "").strip()
        if not tool:
            return {"ok": False, "error": "tool 不能为空"}
        overrides = _param_desc_overrides()
        key = f"{tool}|{param}" if param else f"{tool}|__desc__"
        if description:
            overrides[key] = description
        else:
            overrides.pop(key, None)
        config_store.instance().bulk({"MCP_PARAM_DESC_OVERRIDE": json.dumps(overrides, ensure_ascii=False)})
        try:
            voice_db.append_audit("admin", "mcp_param_desc_set", f"tool={tool} param={param or 'TOOL_DESC'}")
        except Exception:
            pass
        return {"ok": True, "description": description}

    @router.post("/admin/api/mcp/refresh", dependencies=[Depends(require_admin)])
    async def mcp_refresh():
        import mcp_gateway
        return await mcp_gateway.refresh()

    return router
