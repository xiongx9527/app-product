# MCP 网关服务端报错记录

> 记录时间：2026-11-23。当前状态：**已全部解决**（见文末「解决记录」）。
> 这些报错是 **model-proxy 侧**（`mcp_gateway.py`）的问题，不是 java-product。

## 环境

- Python 3.12 venv：`~/.app-product/voice/venv`
- 依赖：`fastmcp 4.2.4` / `langchain 1.5.2` / `mcp 2.3.0`（由 `langchain[mcp]` 安装）
- 对外端点：`http://127.0.0.1:19529/mcp`（FastMCP SSE，已挂载成功，`/mcp` 无鉴权返回 401 正常）
- 上游 MCP：`http://127.0.0.1:8000/mcp/sse`，token 已配（`X-SQLBOT-TOKEN: 74f950fd-be5d-46fc-98f1-018be56e6d03`）
- 上游连通性：**正常**——已成功发现工具 `askdata__model_list`，说明连接 + token 没问题

## 报错 1（阻断）：`POST /admin/api/mcp/refresh` → 500

```
2026-11-23 10:37:58 ERROR: Exception in ASGI application
  + Exception Group Traceback (most recent call last):
  File ".../fastapi/routing.py", line 762, in app
    raw_response = await run_endpoint_function(...)
  File ".../admin/routes_mcp.py", line 86, in mcp_refresh
    return await mcp_gateway.refresh()
  File ".../mcp_gateway.py", line 156, in refresh
    server.tool(name=q, description=desc or None)(_fn)
  File ".../fastmcp/server/providers/local_provider/decorators/tools.py", line 327, in tool
    return decorate_and_register(name_or_fn, name)
  File ".../fastmcp/server/providers/local_provider/decorators/tools.py", line 323, in decorate_and_register
    self.add_tool(fn)
  File ".../fastmcp/server/server.py", line 439, in add_tool
    added = super().add_tool(tool)
  File ".../fastmcp/tools/base.py", line 436, in from_function
    return FunctionTool.from_function(...)
  File ".../fastmcp/tools/function_tool.py", line 354, in from_function
    parsed_fn = ParsedFunction.from_function(fn)
  File ".../fastmcp/tools/function_parsing.py", line 250, in from_function
    raise ValueError(
ValueError: Functions with **kwargs are not supported as tools
```

**根因**：`mcp_gateway.py:155` 定义的转发函数签名是

```python
async def _fn(_q=qualified, **kwargs):
    return await _call_upstream(_q, kwargs)
```

FastMCP 的 `Tool.from_function()` 不允许用 `**kwargs` 签名的函数注册为工具（它要从函数签名解析每个参数生成 inputSchema）。

**出错代码位置**（`model-proxy/voice/mcp_gateway.py` 的 `refresh()` 内）：

```python
server = FastMCP("app-product-gateway")
for q, orig, sid, desc, schema in discovered:
    _upstream_tools[q] = {"server_id": sid, "name": orig}
    qualified = q
    async def _fn(_q=qualified, **kwargs):
        return await _call_upstream(_q, kwargs)
    _fn.__name__ = q.replace("__", "_").replace("-", "_")
    _fn.__doc__ = desc or f"forward to upstream {orig}"
    server.tool(name=q, description=desc or None)(_fn)   # ← 这里抛错
server.add_middleware(_ToolACL())
```

**期望修复方向**：转发函数需要是固定签名（不能 `**kwargs`），但要能透传任意上游工具的动态参数。可选方案：
1. 用 `FunctionTool.from_function()` 手动构造，配合上游返回的 `inputSchema` 生成参数；
2. 从上游 `inputSchema` 动态 `exec` 生成带固定签名的函数；
3. 查 FastMCP 4.x 是否有低层 API（`add_tool` 接受 `Tool` 对象 / `Tool.from_function` 支持传入 schema）直接注册带自定义 schema 的工具。
   - 已知：`FastMCP.add_tool(tool)` 只接受单个 `Tool` 对象；`FastMCP.tool(name=..., description=...)` 装饰器内部仍走 `FunctionTool.from_function()`。

## 报错 2（警告，非阻断）：`Tool.inputSchema` 弃用

```
mcp_gateway.py:141: FastMCPDeprecationWarning: Accessing `Tool.inputSchema` is deprecated;
MCP SDK v2 renamed this field to `input_schema`. Update your code to read `.input_schema` instead.
  getattr(t, "inputSchema", {}) or {})
```

修复：把 `getattr(t, "inputSchema", {})` 改为优先读 `input_schema`（兼容旧版可 fallback）。

## 相关代码上下文

`mcp_gateway.py` 的关键函数（便于定位）：

- `_make_client(server)`：构造上游 Client，支持 SSE / Streamable HTTP（`/sse` 结尾用 SSETransport，否则 StreamableHttpTransport；headers_json 可带 `transport` 字段显式指定）。已验证能连上游、能 `list_tools()`。
- `_call_upstream(qualified_name, arguments)`：按 qualified_name 转发 `tools/call`。
- `refresh()`：连所有 enabled 上游、发现工具、加 `<name>__` 前缀、注册到 FastMCP Server、清理失效 ACL。当前在"注册到 Server"这步失败。
- `_ToolACL` middleware：`on_list_tools` / `on_call_tool` 按 `request.state.api_key_id` 过滤工具（已写好，未验证）。

## 验证方法

修完后：
1. `python3 -m py_compile mcp_gateway.py`
2. 直接调试：`~/.app-product/voice/venv/bin/python -c "import asyncio,sys;sys.path.insert(0,'.');import voice_db,mcp_gateway,os;voice_db.configure(db_path=os.path.expanduser('~/.app-product/voice/voice.db'));asyncio.run(mcp_gateway.refresh())"`
   - 期望输出 `{'servers': 1, 'tools': N, 'failed_servers': []}` 且 `tools` 含 `askdata__*` 前缀工具
3. 重启服务后用 MCP 客户端连 `http://127.0.0.1:19529/mcp/sse`（带 Bearer API-Key）验证 `list_tools` / `call_tool`

---

## 解决记录（2026-11-23 实测通过）

三处修复，验证命令见上「验证方法」：

1. **报错 1（`**kwargs` 不支持）**：`refresh()` 已改为按上游 `inputSchema` 的 `properties/required`
   用 `exec` 动态生成**固定签名**转发函数（每个参数显式列出并透传），不再用 `**kwargs`。
   → `refresh()` 不再抛 `ValueError`，成功注册工具。

2. **报错 2（`inputSchema` 弃用）**：`refresh()` 发现工具时改为优先读 `input_schema`、
   fallback 到 `inputSchema`。用 `python -W error::DeprecationWarning` 验证无警告。

3. **新发现的阻断 bug：上游 401 / 0 工具**：`voice_db.mcp_servers_list()` 的 SELECT
   **漏查 `biz_type` 列**，导致 `refresh()` 拿到的 server 永远没有业务类型 → `_prepare_auth`
   恒走 generic 静态 headers → 硬编码 token 失效 → 上游 `/mcp/sse` 返回 401、发现 0 工具。
   修复：SELECT 补上 `biz_type` 列；并把上游服务器 id=2 的 `biz_type` 设为 `askdata`
   （走账号密码动态换 token + 缓存，不再依赖写死的 token）。
   顺带修复 `failed_servers` 统计口径：改用本次循环的失败集合，不再读更新前的 `last_ok` 旧值。

**最终实测结果**：
- `refresh()` → `{'servers': 1, 'tools': 13, 'failed_servers': []}`（无警告）
- 网关 `list_tools()` → 11 个工具（经 `_ToolACL` 按 API-Key 过滤），全部带 `askdata__` 前缀，样例：`askdata__model_list` / `askdata__workspace_list` / `askdata__chat_start`
- `call_tool(tools[0], {})` → 成功（转发链路打通）

代码位置：`model-proxy/voice/mcp_gateway.py`（refresh / _prepare_auth）、`model-proxy/voice/voice_db.py`（mcp_servers_list）。
