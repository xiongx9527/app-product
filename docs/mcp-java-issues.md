# java-product MCP 侧问题记录（交 java agent）

> 记录时间：2026-11-23。范围：**只列 java-product（8000）侧的问题**，model-proxy 侧问题不在此文档。
> 背景：model-proxy 正实现 MCP 中转网关，上游接 java-product 的 MCP server（`/mcp/sse`），
> 目前连接与工具发现**基本正常**，以下是 java 侧需要确认/修复的点。

## 环境

- 服务：`java-product/askdata-server`，端口 8000，当前运行中（另一个 agent 启动）
- MCP 配置（`application.yaml:265-270`）：`transport=http-sse`、`endpoint=/mcp`、鉴权 `sa-token-login`
- MCP 端点：`GET /mcp/sse`（SSE 建流）+ `POST /mcp/messages/{uuid}`，需 `X-SQLBOT-TOKEN` header
- 工具（`AskdataMcpTools.java`）：`question_answer`(:210)、`mcp_question`(:557)、`datasource_list`、`workspace_list`、`model_list`、`server_info`、`access_token` 等

## 已验证正常

- `GET /` → 200
- `GET /mcp/sse` 无 token → 401（鉴权生效，符合预期）
- 用 `X-SQLBOT-TOKEN` → `GET /mcp/sse` 返回 **200**（token 有效）
- MCP client `list_tools()` 能发现 `model_list` 等工具（java 侧 MCP server 工作正常）

## 问题 1：默认管理员账号登录失败（需确认）

**现象**：
```
POST http://localhost:8000/api/v1/login/access-token
Content-Type: application/json
{"username":"admin","password":"<README 默认密码>"}
→ {"detail":"账号或密码错误"}
```

但 `README.md:58` 写的默认管理员账号（admin / 默认密码）与实际不符。

**对比**：MCP 专用的 token 端点用**同样账号密码**却成功：
```
POST http://localhost:8000/api/v1/mcp/access_token
Content-Type: application/json
{"username":"admin","password":"<README 默认密码>"}
→ {"token":"...","tokenName":"X-SQLBOT-TOKEN","access_token":"..."}
```

**疑问（请 java agent 确认）**：
1. 默认管理员账号/密码是否已改？README 的默认值是否还准确？
2. 为什么 `/api/v1/mcp/access_token` 能校验通过、而 `/api/v1/login/access-token` 失败？两者用的是同一套用户表/密码校验吗？
   - 从代码看，`LoginController.accessToken()` 用 `CryptoUtil.decryptSqlbot(username/password)` 解密后再查 `userRepository` + `PasswordHasher.verifyPassword`；
   - `SqlbotMcpCompatController` 的 `access_token` 工具走 `bindTokenStrict` 校验——请确认两者账号体系是否一致。
3. 如果 README 默认值已失效，请给出当前可用的账号密码，或修正 README。

## 问题 2（信息确认）：token 有效期与续期方式

**现象**：`/api/v1/mcp/access_token` 换到的 token 可用，但需要确认：
1. token 有效期多久？（代码里 sa-token 配置 `token-style=uuid`、8 天有效？）
2. 网关侧是否需要定期重新换取 token？有没有 refresh 机制？
3. token 是否绑定 IP / 设备？

请 java agent 确认 sa-token 的有效期配置与续期策略，便于 model-proxy 侧决定是动态获取还是缓存 token。

## 备注

- model-proxy 侧目前用**静态 token**（手工填 `X-SQLBOT-TOKEN`）连 `/mcp/sse`，已验证可用。
- 若 java 侧 token 会过期且无续期端点，model-proxy 侧将改为"配置账号密码 + 每次连接前调 `/api/v1/mcp/access_token` 动态换取"。
- 请不要改 model-proxy 的代码（那是另一个 agent 的范围）。
