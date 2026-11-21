# 9529 MCP 网关方案设计（讨论稿）

> 状态：设计讨论，未实施。日期 2026-11-21。
> 目标：9529 作为 **MCP 网关（中转）**，对外暴露一个 MCP endpoint，背后连接并管理多个外部
> MCP server，把它们的工具聚合后转发。不在核心链路引入 LangChain。
>
> **首个真实上游**：一个 Java 编写的「问数」工具，它自身提供 MCP server。网关中转它，
> 让 AI 客户端（Claude/Cursor/自研）能通过 9529 统一入口调用问数能力（自然语言问答/查数）。

## 一、已拍板决策

1. **角色**：9529 做 MCP Server（网关/中转），把外部 MCP server 的工具聚合后对外暴露。
2. **传输**：上游只接 **SSE / Streamable HTTP**（远程 MCP server）；不做 stdio。对外也用 HTTP/SSE。
3. **工具冲突**：加 **server 前缀**（如 `github__search`、`slack__search`），可溯源、不冲突。
4. **对外接口**：单独 `/mcp` 路径，走现有 **API-Key 鉴权 + IP 白名单**（和 `/voice` `/llm` 一致）。
5. **动态配置**：上游 MCP server 配置存 **SQLite + 管理面板**，改完**重连生效**（客户端重连即可拿到新工具列表）。
6. **LangChain**：**核心链路不引入**。MCP 协议转发 + 工具聚合用官方 `mcp` SDK 的 `ClientSession` + FastAPI SSE 即可。
7. **按 API-Key 隔离工具可见性**（2026-11-21 拍板）：不同 Key 看到的 MCP 工具不同，**粒度到单个工具**。
   工具有「默认/非默认」之分：**默认工具所有 Key 自动拥有**，其它工具由管理面板单独给 Key 勾选授权，
   存 SQLite `mcp_tool_acl`。Key 可见工具 = 默认工具 ∪ 该 Key 的专属授权。

### LangChain 的重新评估
- `langchain-mcp-adapters` 的价值在 **client 侧**（把 MCP 工具转成 agent 用的 tools），与"我做 server/网关"方向相反。
- 项目依赖刻意精简（`requirements-base.txt` 只有 fastapi/uvicorn/httpx/redis/pypinyin），为网关加 LangChain 收益低、成本高。
- **可选增强（二期）**：若上游工具过多需要语义筛选（按意图挑工具），可加一层工具检索，那时再评估 LangChain/LangGraph。当前不做。

## 二、架构

```
AI 客户端 (Claude/Cursor/自研)
    │  MCP over HTTP/SSE  (/mcp, Bearer API-Key)
    ▼
┌─────────────────────────────────────┐
│ 9529 MCP 网关                        │
│  - 对外: FastAPI /mcp (SSE)          │
│  - 工具注册: 聚合各上游 tools，加前缀   │
│  - 转发: tools/call 按前缀路由         │
│  - 上游管理: SQLite 配置 + 连接池      │
│  - 鉴权: 复用 VOICE_API_KEY + 白名单   │
│  - 工具授权: 按 key_id 过滤可见工具      │
└──────────────┬──────────────────────┘
               │ MCP over SSE/HTTP (各上游 URL + headers)
   ┌───────────┼───────────┐
   ▼           ▼           ▼
Java 问数     MCP server B  MCP server C
(首个上游)     (github)      (其它)
```

**首个上游：Java 问数 MCP server**
- 上游配置示例：`name=askdata`（工具前缀）、`url=<Java 问数的 SSE/HTTP 地址>`、`headers_json=<鉴权头>`
- 它暴露的工具（如自然语言查数、表结构查询等）经网关聚合后，对外变成 `askdata__<tool>`
- AI 客户端只需连 9529 的 `/mcp`，由网关转发到 Java 问数；问数的具体工具由 `list_tools()` 自动发现，不写死在网关代码里
- 好处：Java 问数不必自己暴露公网/处理鉴权，统一由 9529 的 API-Key + 白名单把关

**按 Key 隔离工具**：
- 网关聚合出的每个工具（带前缀，如 `askdata__query`）都是可授权单元。
- **默认工具**：管理面板可勾选**多个**工具设为默认（存 `key_id=0` 的哨兵记录），所有 Key 自动拥有，
  无需逐个配置。新增 Key 一建好就自带这些工具——这也解决了 App 内部那个 Key 的默认可用性。
- **专属工具**：其它工具由管理面板单独给某个 Key 勾选授权。
- `/mcp` 会话按 key_id 过滤：`tools/list` 返回 **默认工具 ∪ 该 Key 专属工具**；`tools/call` 调用前
  校验 qualified_name 是否在这两个集合内，不在则拒绝。这样不同 Key 看到的「MCP server 内容」可以完全不同。

## 三、核心组件

### 1. 上游配置表 `mcp_servers`（SQLite，schema v15）
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| name | TEXT NOT NULL UNIQUE | 简称，作工具前缀（如 `github`） |
| url | TEXT NOT NULL | SSE / Streamable HTTP endpoint |
| headers_json | TEXT NOT NULL DEFAULT '{}' | 鉴权 headers（**脱敏存储/读取**，不回传明文） |
| enabled | INTEGER NOT NULL DEFAULT 1 | 启用/停用 |
| timeout_sec | INTEGER NOT NULL DEFAULT 30 | 连接/调用超时 |
| last_ok / last_error / last_seen | | 健康状态 |
| created_at / updated_at | INTEGER NOT NULL | 秒 |

### 1b. 工具授权表 `mcp_tool_acl`（SQLite，schema v15）
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| key_id | INTEGER NOT NULL | 关联 `admin_api_keys.id`；**`0` = 默认工具哨兵**，对所有 Key 生效 |
| qualified_name | TEXT NOT NULL | 带前缀的工具全名，如 `askdata__query` |
| created_at | INTEGER NOT NULL | 秒 |
| UNIQUE(key_id, qualified_name) | | 防重复授权 |

- `key_id=0` 的记录表示**默认工具**，可有多条（支持多个默认工具）；所有 Key 自动拥有。
- `key_id>0` 的记录是某个 Key 的**专属授权**。
- Key 可见工具 = `key_id=0` 全部 ∪ `key_id=self` 全部。
- 工具被上游删除/改名后，`refresh()` 清理失效的 qualified_name（避免面板出现幽灵工具）。

### 2. 上游连接管理 `voice/mcp_gateway.py`（新建）
- `configure()`：从 SQLite 读所有 enabled 上游，建立 `ClientSession` 连接（sse_client / streamablehttp_client）
- `list_all_tools()`：聚合各上游 `list_tools()`，工具名加 `<name>__<tool>` 前缀，返回统一列表（全量）
- `tools_for_key(key_id)`：取 `key_id=0`（默认工具）∪ `key_id=self`（专属）的授权，
  对全量工具过滤，返回该 Key 可见的工具子集；key_id=0 有任意条即支持多个默认工具
- `call_tool(qualified_name, args, key_id)`：按前缀找到上游 → 转发 `tools/call` → 原样回传结果；
  **调用前先校验 qualified_name 是否在 `tools_for_key(key_id)` 内**，不在则拒绝
- `refresh()`：配置变更后重连（管理面板保存后调用；客户端重连即可拿到新工具列表），并清理工具授权表里的失效项
- 连接池 + 失败退避：某上游连不上不影响其它；健康状态写回 `mcp_servers`

### 3. 对外 endpoint `/mcp`（FastAPI）
- MCP over HTTP/SSE：用官方 SDK 的 FastAPI 挂载，或手动实现 SSE + JSON-RPC
- 会话建立时按 key_id 调 `tools_for_key()` 生成**该 Key 可见的工具列表**（默认工具 ∪ 专属工具）
- `tools/call` 先校验归属再按前缀路由
- 鉴权：中间件里 `/mcp` 需要 Bearer API-Key（复用 `_path_needs_api_key` 把 `/mcp` 加入需鉴权路径），
  IP 白名单同样生效；鉴权通过后从 `request.state.api_key_id` 拿到 key_id 供工具过滤使用

### 4. 管理面板配置页「MCP 网关」
- 上游列表：name / url / 启用 / 健康状态 / 工具数；增删改
- headers 配置：JSON 编辑，API Key 类字段脱敏显示
- 保存后触发 `refresh()` 重连
- **工具授权**：在「API KEY」管理页，每个 Key 可勾选专属可见工具（按上游分组的全量工具勾选框，
  带前缀）；保存写入 `mcp_tool_acl`（key_id=self）。此外提供**全局默认工具**配置（key_id=0，
  支持勾选多个），对所有 Key 生效、自动拥有，是「不同 Key 看到不同内容」的基线。

### 5. 概览页接入（可选）
- 加一组「MCP 网关」：上游数量、启用数、工具总数、各上游健康

## 四、依赖

新增官方 MCP Python SDK（如 `mcp>=1.x`），提供 `ClientSession`、`sse_client`、`streamablehttp_client`、FastAPI SSE 挂载。**不引入 LangChain**。

## 五、实施步骤（分阶段）

1. **数据层**：schema v15 建 `mcp_servers` + `mcp_tool_acl` 两表 + 数据访问函数（CRUD + 健康 + 工具授权）+ 迁移脚本 015
2. **网关核心**：`voice/mcp_gateway.py`——连接管理、工具聚合（前缀）、调用路由、重连、健康、**按 Key 过滤工具**
3. **对外 endpoint**：`/mcp` SSE + JSON-RPC，接入鉴权中间件，按 key_id 过滤 tools/list + 校验 tools/call
4. **管理面板**：MCP 网关配置页（上游 CRUD + headers 脱敏 + 保存重连）+ API KEY 页工具授权勾选
5. **概览页**：MCP 网关健康信息
6. **测试**：上游配置 CRUD、工具前缀聚合、调用路由、同名工具、上游故障隔离、鉴权、
   **按 Key 工具过滤（多个默认工具对所有 Key 生效 + 专属工具仅本 Key 可见 + 未授权工具调用被拒）**、
   重连生效

## 六、风险与注意

- **工具名前缀**：客户端需按 `server__tool` 调用；在工具描述里说明命名规则
- **headers 脱敏**：API Key 类 header 不明文回传（复用现有 `MASKED_KEYS`/`HIDDEN` 思路）
- **上游故障隔离**：单个上游连不上/超时不能拖垮网关；连接失败退避（参考 `voice_sync._redis_bad_ts`）
- **重连时机**：配置保存后 `refresh()`；客户端重连拿新工具列表（不做 list_changed 通知，简化）
- **鉴权一致性**：`/mcp` 必须走 API-Key + 白名单，不能免鉴权暴露
- **工具授权必须服务端校验**：`tools/call` 不能只靠 tools/list 隐藏，客户端直接发 call 也要按 key_id 拒绝未授权工具，否则可绕过
- **工具名稳定性**：qualified_name 含前缀且来自上游工具名；上游改名会导致授权失效，用 refresh 清理 + 面板提示
- **零 LangChain**：核心链路不引入；二期若做工具语义筛选再评估

## 七、待确认

- 对外 SSE 的具体实现：用官方 SDK 的 FastAPI 挂载还是手写 SSE + JSON-RPC（看 SDK 版本能力）
- 是否需要在网关侧缓存上游工具列表（避免每次会话都连所有上游）
- 上游 headers 的密钥存储：明文 SQLite（本地库）还是复用系统 keyring（当前无 keyring，倾向本地库 + 文件权限）
- 工具描述/参数是否需要中转时改写（默认原样）
