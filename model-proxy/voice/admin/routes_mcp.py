"""管理面板路由 · MCP 中转网关域：上游 CRUD / 工具授权 / 重连。

由 admin_panel.register_admin_routes 在运行时加载。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

import admin_panel as ap
import voice_db


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
        fields = {k: body[k] for k in ("name", "url", "headers_json", "enabled", "timeout_sec", "biz_type", "tool_prefix") if k in body}
        if not voice_db.mcp_server_get(sid):
            from fastapi import HTTPException
            raise HTTPException(404, "上游不存在")
        voice_db.mcp_server_update(sid, fields)
        return {"ok": True}

    @router.delete("/admin/api/mcp/servers/{sid}", dependencies=[Depends(require_admin)])
    def mcp_server_delete(sid: int):
        if voice_db.mcp_server_has_tools(sid):
            return {"ok": False, "reason": "该网关的工具已加入对外清单，请先移除工具再删除"}
        voice_db.mcp_server_delete(sid)
        return {"ok": True}

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
        for q, meta in (mcp_gateway._upstream_tools or {}).items():
            srv = voice_db.mcp_server_get(meta["server_id"]) or {}
            schema = meta.get("input_schema") or {}
            props = schema.get("properties") or {}
            required = set(schema.get("required") or [])
            # 给每个参数补上推断的位置（header/body/query）与必填标记，供面板展开展示。
            params = []
            for pn, pp in props.items():
                if not isinstance(pp, dict):
                    pp = {}
                params.append({"name": pn, "type": pp.get("type") or "string",
                               "required": pn in required, "in": _param_location(pn),
                               "description": pp.get("description") or ""})
            tools[q] = {"server_id": meta["server_id"], "name": meta["name"],
                        "server": srv.get("name") or "", "description": meta.get("description") or "",
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
            return {"ok": True, "tools": [
                {"name": t.name, "description": getattr(t, "description", "") or ""} for t in tools]}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}

    @router.post("/admin/api/mcp/refresh", dependencies=[Depends(require_admin)])
    async def mcp_refresh():
        import mcp_gateway
        return await mcp_gateway.refresh()

    return router
