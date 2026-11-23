# model-proxy MCP 对外接口

> 状态：已实施。端口 `19529`（可通过服务配置修改）。日期 2026-11-23。
> 对外提供 **MCP 网关**：把上游 MCP server（当前为 java-product 的「问数」askdata）的工具聚合后统一对外暴露。

## 一、对外地址与支持的协议

挂载点 `/mcp`，**同时支持两种 transport**（同一份工具，两条链路等价）：

| 协议 | 端点 | 说明 |
| ---- | ---- | ---- |
| **SSE** | `GET /mcp/sse` | 握手，返回 `endpoint` 事件（`/mcp/messages/?session_id=...`）；后续通信走 `POST /mcp/messages/` |
| **Streamable HTTP** | `POST /mcp/` | 单端点，initialize / tools/list / tools/call 均走这里；支持 GET、DELETE 管理会话 |

- 完整地址 = 服务根地址 + `/mcp`。例：本机 `http://127.0.0.1:19529/mcp/sse`、`http://127.0.0.1:19529/mcp/`。
- 客户端二选一即可：
  - SSE：`SSETransport("http://<host>:19529/mcp/sse")`
  - Streamable：`StreamableHttpTransport("http://<host>:19529/mcp/")`
- 网关侧 `@agentscope-ai/agentscope` 的 `HTTPMCPClient` 两种都支持：
  `transportType: 'sse'` 对应 SSE 端点，`'streamable-http'` 对应 `/mcp/`。

## 二、鉴权

- 与 `/llm`、`/voice` 等对外接口**统一 API-Key 鉴权**：`Authorization: Bearer <API-Key>`。
- 仅当服务端 `VOICE_API_KEY_AUTH=on` 时强制校验；`off` / 未设置时不校验（便于本地调试）。
- 接口自带鉴权（mount 的子 app 不走主 app 中间件），校验口径一致：`voice_db.api_keys_verify`。
- 工具可见性按 Key 过滤：`tools/list` 只返回该 Key 可见工具，`tools/call` 未授权工具拒绝。
  - `key_id=0` 的默认工具所有 Key 可见；其它工具由管理面板给指定 Key 勾选。

## 三、工具

- 当前上游「问数」askdata 暴露 13 个工具，统一加前缀 `askdata__`：
  `model_list`、`workspace_list`、`chat_start`、`mcp_start`、`datasource_list`、`question_answer`、
  `mcp_ws_list`、`server_info`、`access_token`、`mcp_datasource_list`、`mcp_question`、`mcp_assistant`、`mcp_model_list`。
- 工具名 = `<工具前缀>__<上游工具名>`；前缀在管理面板的网关配置里设置。
- askdata 网关用账号密码动态换取 token（不落库明文），generic 网关用静态 headers。

## 四、管理面板

`/admin` → MCP 网关 / MCP 工具：配置上游网关、业务类型、工具前缀、传输协议、地址，
连通测试、启用/停用、勾选对外提供的工具。上游变更后面板「重连并发现工具」即时生效，
客户端下次 `initialize` 即可拿到最新工具列表（无需重启）。

## 五、对接示例（Python / FastMCP）

```python
from fastmcp import Client
from fastmcp.client.transports import SSETransport, StreamableHttpTransport

# 二选一
async with Client(SSETransport("http://127.0.0.1:19529/mcp/sse")) as c:
    tools = await c.list_tools()
    print([t.name for t in tools])

async with Client(StreamableHttpTransport("http://127.0.0.1:19529/mcp/")) as c:
    tools = await c.list_tools()
```

## 六、uni-app 固定对接（客户端侧）

app 端**不提供手动添加 MCP server 的入口**，内部固定下发一个 MCP server 给网关：

- 地址 = 「服务设置」里配置的语音服务地址 + 固定路径 `/mcp/sse`（跟随配置，不写死 host/port）。
- 传输 = `sse`。
- 设置页移除 MCP 配置入口，用户无感；网关用该固定 server 连上并注册工具到助手工具箱。
