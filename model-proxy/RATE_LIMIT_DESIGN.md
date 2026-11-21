# 9529 限流方案设计（三类计量）

> 状态：设计稿，未实施。讨论日期 2026-11-20。
> 适用：`model-proxy/voice/`（9529 本地语音/LLM 代理）。
> 关联：`API_KEY_QUOTA_DESIGN.md`（周期配额）、`DB_SCHEMA.md`、`schema.sql`。

## 一、结论：为什么选三类计量

限流管**分钟级速率**（挡突发、防刷爆），配额管**周期总量**（成本控制，见 `API_KEY_QUOTA_DESIGN.md`）。两者共存，先做限流。

对比过两套流量口径，选**三类计量**（LLM=token / ASR=音频秒 / TTS=字符），理由：

| 维度 | 字节数（请求+响应体） | 三类计量（选用） |
|---|---|---|
| 测什么 | 传输层管道占用 | 上游 API 实际消耗 |
| 与成本相关性 | 弱：同样 100KB，3 秒音频和几千 token 的 LLM 响应成本差百倍 | 强：直接对应各上游计费口径 |
| 埋点 | 要 wrap 响应流拿字节数，侵入大 | 现成：LLM usage 已解析、ASR 有 duration、TTS 有 input 长度 |
| 可观测性 | 只能说"流量超限" | 能说"LLM token 超限"，便于调阈值 |
| 多租户套餐 | 用户理解不了"每月 5GB" | "每月 100 万 token"是行业通用口径 |

字节数口径更适合当**单请求大小上限**（入口 Content-Length 校验），不是限流——它做不成套餐，且一个 9MB 的请求虽然不超"10MB/min"但已足够危险。

## 二、限流模型：策略驱动（仅 api-key）

**范围：只做 per-key 限流，不做 per-IP。** 注意区分：全局 IP 白名单 `VOICE_IP_ALLOW`
是**访问控制**（谁能连），不是限流，保留不动；砍掉的是"按 IP 计数限流"这一层。

**核心：阈值不内联在 key 上，而是抽成「策略（policy）」；key 引用策略。**

策略是命名模板（一组 4 维阈值），多个 key 可复用同一套；改策略一处，所有引用它的
key 即时生效。无引用时用默认策略。沿用 `rate_store` 门面：策略只提供阈值，计数仍在
门面内按 key 做——`check_and_consume(key_id, policy)`。

**限流维度（4 个独立计数器，任一超限即 429）：**

| | 次数（令牌桶，事前判断） | 流量（滑动窗口，事后累加） |
|---|---|---|
| per-key | 由该 key 引用的策略定 | 同策略的 llm_tokens / asr_seconds / tts_chars |

默认策略初始阈值（新建时播种一条，受保护不可删禁）：
- 次数 100 req/min
- 三类：LLM 20k token、ASR 300s、TTS 50k 字符 per min

- **身份来源**：现有 `request.state.api_key_id` / `api_key_name`（HTTP `security_middleware` 与 WS `_ws_auth_ok` 已记录）。无 key 的请求（鉴权关闭时）不限流。
- 已登录管理会话、环回地址、健康探测路径豁免（见第六节）。

### 开关与策略（v12 调整：全局统一控制）

**"是否限流"只由全局开关决定，"限多严"由策略决定**：

| 全局 RATE_LIMIT_ENABLED | 绑定策略 | 结果 |
|---|---|---|
| 关 | 任意 | **不限流**（完全跳过） |
| 开 | 有绑定 | 用绑定的策略（多个取最严格） |
| 开 | 无绑定 | 用**默认策略** |

- **两层控制**：
  1. **全局** `RATE_LIMIT_ENABLED`（`voice.conf` / 管理面板安全设置页）——关时全部跳过，紧急逃生；开时所有 key 都限流
  2. **策略** `enabled`——停用某条策略用于灰度（停用的策略即使被绑定也不参与合并，key 回退到其余策略或默认）
- **per-key 开关已废弃**（v12 删除 `admin_api_keys.rate_limit_enabled` 列）：绑定策略即生效，全解绑则回退默认策略，不再有单个 key 的启用开关。
- **默认策略**：初始化播种一条默认策略，没绑策略的 key 用它。
- **开关默认值 = 关闭**：默认不限流，需显式打开全局开关才生效。理由：当前真机联调（`adb reverse` / iOS 隧道）依赖不限速，默认开会打断现有链路；且"先只观察再启用"更稳。

### 策略绑定规则（已拍板）

1. **一个 key 可绑多个策略，取最严格**：
   - 绑定关系是「多对多」关联表（`rate_policy_bindings`）：`username` + `policy_id`
   - **合并算法**：把该 key 绑定的所有**启用中**策略的每一维阈值取最小值，合成一个「有效策略」再做计数
     （例如绑了 100req 和 50req 两条 → 有效阈值 50req；不是各自独立计数）；停用的策略不参与合并
   - 开关开但没绑任何策略（或绑定的都停用）→ 用默认策略
2. 策略只在 `rate_store` 门面里当阈值来源用，计数逻辑不变。

## 三、算法与时序（关键）

**次数用令牌桶**：每请求消耗 1 个令牌，事前判断，窗口边界不抖动、允许合理突发。
**三类计量用滑动窗口累加**：因为 token / 音频秒是请求**完成后**才知道的。

时序矛盾的处理：

1. 请求进入 → 次数令牌桶检查（事前，不够直接 429）
2. 请求处理 → 完成
3. 响应阶段读计量值，累加进滑动窗口（事后）：
   - LLM：非流式读 `usage`；流式对 openai/azure 注入 `stream_options.include_usage=true` 抓末帧（现有逻辑已打通，见 `openai_voice_server.py` 的 `[llm-usage]` 与 `X-Usage-*` 响应头）；拿不到时回退字符估算并标 `estimated=true`
   - ASR：`duration = x.size / SAMPLE_RATE`（上传音频时长，计费口径）；`speech_duration` 仅做幻觉判断，不用
   - TTS：`len(body.input.strip())`（与 DeepSeek 计费口径一致）
4. 累加后若**超过阈值**，本次请求放行（不事后撤销），从**下一个请求**开始拒绝。

> 这个取舍对语音助手完全够用——一次请求就是一个完整动作，不存在"一个请求内狂刷"。真正要防的单次超大请求，靠第四节的请求上限。

WS `/voice/ws/inference`：握手阶段做次数限流；task-finish 事件里按 task 类型记 ASR 秒 / TTS 字符。

## 四、单请求上限（与限流互补，防单次超大）

在入口直接校验，超限返回 413：

- ASR 上传音频 ≤ 60 秒（按 WAV 头推算，或按字节上限 ≤ 2MB：16k/16bit/mono 一分钟约 1.9MB）
- TTS 输入 ≤ 5000 字符
- LLM 单次 prompt token ≤ 20000（拿不到精确值时按字符估算）

这是**请求校验**，不是"每分钟 N MB"的限流——后者放行的单个 9MB 请求仍可能打爆内存。

## 五、429 响应规范

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
Content-Type: application/json

{
  "detail": "LLM token 用量超限",
  "kind": "llm_tokens",      // requests | llm_tokens | asr_seconds | tts_chars
  "used": 21340,
  "limit": 20000,
  "reset_at": 1763659200     // 窗口重置时间（秒 epoch）
}
```

- `detail` 说人话（"请求次数超限" / "LLM token 用量超限" / "ASR 音频时长超限" / "TTS 字符用量超限"）。
- 带 `Retry-After`（令牌桶按补充速率算，滑动窗口按窗口剩余时间算）。
- 9529 网关已有失败兜底提示音链路：超限应播**专门提示**（"用量超限"），区别于普通服务错误——需网关侧配合加一种失败类型。

## 六、豁免规则

以下不计入限流、不被拦截：

- 健康探测与文档：`/health`、`/voice/health`、`/llm/health`、`/docs` 等（`_API_KEY_OPEN_PATHS`）——这些路径本就不参与鉴权，自然也不限流
- 已登录管理面板会话（Cookie 有效）——面板操作不触发限流
- 鉴权关闭且请求无 key ——没有身份，无法按 key 限流，放行（此时靠全局 IP 白名单 `VOICE_IP_ALLOW` 做访问控制）

> 限流只针对"带有效 key 的数据接口请求"。测试时用一个开关打开的测试 key 发请求即可触发，不需要构造来源 IP。

## 七、数据结构（schema v11，两张新表 + 一列）

**1. `rate_policies`（策略定义）**：

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| name | TEXT NOT NULL UNIQUE | 策略名（面板展示） |
| description | TEXT | 备注 |
| req_per_min | INTEGER NOT NULL | 次数/min |
| llm_tokens_per_min | INTEGER NOT NULL | token/min |
| asr_seconds_per_min | INTEGER NOT NULL | 音频秒/min |
| tts_chars_per_min | INTEGER NOT NULL | 字符/min |
| enabled | INTEGER NOT NULL DEFAULT 1 | 停用用于灰度 |
| is_default | INTEGER NOT NULL DEFAULT 0 | 默认标记，允许多个 |
| is_builtin | INTEGER NOT NULL DEFAULT 0 | 内置策略（唯一、不可删/禁），没绑策略的 Key 用它兜底 |
| period | TEXT NOT NULL DEFAULT 'minute' | v14：限流单位 minute/hour/day/week/month |
| created_at / updated_at | INTEGER NOT NULL | 秒 |

**v14 时间单位**：阈值列名仍为 `*_per_min`（历史名），实际含义是"每 period"。
`period` 对应秒数：minute=60 / hour=3600 / day=86400 / week=604800 / month=2592000（固定秒数近似，月=30天）。
令牌桶补充速率 = 阈值 / 周期秒数；多策略 period 不同时按"每秒速率"归一化取最严，再换算到最短 period。存量策略默认 minute，行为不变。

**默认策略**：初始化播种一条内置策略（`is_builtin=1`，阈值取第二节那套），没绑策略的 key 用它。

**默认策略保护**（类似内置管理员）：`is_default=1` 的策略**不可删除、不可禁用**
（`enabled` 恒为 1），也不允许取消默认标记（除非先把另一条设为默认，保证始终有一条）。
理由：默认策略是所有 key 的兜底，删了/停了会导致开关打开但无阈值可用。

**2. `rate_policy_bindings`（绑定关系，多对多）**：

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| username | TEXT NOT NULL | → admin_api_keys.username（ON DELETE CASCADE） |
| policy_id | INTEGER NOT NULL | → rate_policies.id（ON DELETE CASCADE） |
| UNIQUE(username, policy_id) | | 同一 key 不重复绑同一策略 |

一个 key 可绑多条策略 → 合并时每维取最小值（最严格）。删策略/删 key 时级联清绑定，key 自动回退默认策略。

**3. 开关**：只有全局 `RATE_LIMIT_ENABLED`（`voice.conf` / 安全设置页）——关时全部跳过，开时所有 key 按绑定策略限流。
（v12 起不再有 per-key 的 `rate_limit_enabled` 列。）

**判定流程**：全局关 → 放行；全局开 → 取该 key 的绑定策略（多则取最严格，无则用默认策略）→ 计数判断。

**面板：独立「限流策略」管理页**

主导航增加一张独立卡片「限流策略」，两块内容：

- **策略列表**（`rate_policies`）：表格列出各策略的 4 维阈值、启用状态、是否默认；新增/编辑/删除/设默认（默认策略禁删禁停）
- **key 绑定区**：列出所有 `admin_api_keys`，每个 key 一个「限流开关」+「绑定策略」多选；关掉开关的 key 即使绑了策略也不限流（策略保留，方便再开）

**全局默认**（`voice.conf`，仅用于初始化播种默认策略，之后以库为准）：

```
RATE_LIMIT_DEFAULT_REQ=100
RATE_LIMIT_DEFAULT_LLM_TOKENS=20000
RATE_LIMIT_DEFAULT_ASR_SECONDS=300
RATE_LIMIT_DEFAULT_TTS_CHARS=50000
```

**运行时计数**（`rate_store` 门面内，内存或 Redis，按配置）：
```python
# 次数令牌桶 {key_id: (tokens, last_refill_ts)}
# 流量滑动窗口 {(key_id, kind): [(ts, amount), ...]}
# 策略只提供阈值，不持有计数状态
```

> **IP 与 api-key 的去向**：限流只按 api-key 计数，但**数据统计/审计里 IP 和 api-key 都保留**——
> `audit.actor` 由 `client_ip_audit_middleware` 写入客户端 IP，限流埋点记录 key 身份
> （`request.state.api_key_id` / `api_key_name`），两者都用于追溯"哪个 key、从哪个 IP 调了什么"。
> 这是日志/统计维度，和限流计数无关，不受本次改动影响。全局 IP 白名单 `VOICE_IP_ALLOW`
> 也保留（访问控制）。

**后端选择 = 配置决定，调用者无感**（沿用项目 `config_store.py` 的门面原则）：

新增 `voice/rate_store.py` 作为统一门面。限流调用方（`openai_voice_server.py` 的
`security_middleware`、各 handler）**只调门面接口，不感知后端是内存还是 Redis**：

```python
# rate_store.py 对外接口（同步，微秒级）；只按 key，无 dim 维度
configure(backend: str | None = None, redis_url: str | None = None) -> None
check_and_consume(key_id, kind, limit, cost=1) -> tuple[bool, int]  # (是否放行, retry_after秒)
record(key_id, kind, amount) -> None              # 滑动窗口累加（计费用）
reset(key_id) -> None                              # 改阈值/删 key 时清状态
stats() -> dict                                    # 面板展示
```

后端由配置决定，不在代码里判断：

- `RATE_LIMIT_BACKEND=memory`（默认）→ 内存令牌桶 + dict 滑动窗口
- `RATE_LIMIT_BACKEND=redis`（或配了 `REDIS_URL` 且 backend=auto）→ Redis 令牌桶（Lua 脚本原子）
  + `ZSET` 滑动窗口，`INCR`/`ZADD` + `EXPIRE` 自动过期
- **透明降级**：配了 Redis 但连不上 / 未装依赖 → 自动回退内存（与 `voice_sync.py` 的降级策略一致），
  日志打一行警告，业务不中断。

配置模板（`voice.conf.example`）加：

```
# RATE_LIMIT_BACKEND=auto    # auto | memory | redis；auto=配了 REDIS_URL 就用 Redis
# REDIS_URL=redis://127.0.0.1:6379/0   # 复用现有 Redis；与配置缓存/纠错词表缓存共用实例
```

门面内部持有两个后端实现（`_MemoryBackend` / `_RedisBackend`），启动 `configure()` 时按配置选一个，
之后所有调用走同一接口。**将来从单机升多实例，只改配置、不改调用方一行代码**——这正是
`config_store.py` 已经验证过的模式。

> 注意：限流的"判断 + 扣减"必须同步（内存微秒级 / Redis Lua 一次往返），异步的只是落库统计
> （见第九节）。门面接口保持同步，不在这里引入 async。

## 八、实施步骤（建议分两阶段）

**阶段 1：次数限流 + 策略框架**（性价比最高）
1. `voice/rate_store.py`：新建门面 + `_MemoryBackend`（令牌桶），`configure()` 按配置选后端；门面接收"有效策略"阈值
2. `voice_db.py`：schema v11，新建 `rate_policies` / `rate_policy_bindings` 两表 + 迁移；幂等播种一条默认策略（带保护）。v12 又删除了 v11 曾加的 `rate_limit_enabled` 列（见下）
3. `admin_panel.py`：新增独立「限流策略」管理页——策略列表（默认标记/阈值/启用，默认策略禁删禁停）+ key 绑定区（开关 + 策略多选）
4. `openai_voice_server.py`：`security_middleware` 鉴权后查 key 开关→取有效策略→调 `rate_store.check_and_consume(...)`；全局开关 `RATE_LIMIT_ENABLED`；429 + Retry-After
5. 测试：令牌桶补充/突发/超限、豁免、并发、多策略取最严格、默认策略不可删禁、内存/Redis 后端切换

**阶段 2：三类计量**
1. `voice/rate_store.py`：加 `_RedisBackend`（Lua 令牌桶 + ZSET 滑动窗口），配置 auto 时按 REDIS_URL 选用
2. `openai_voice_server.py`：三个 handler 的计量埋点（LLM usage 已有，补落计数；ASR/TTS 新增），调 `rate_store.record(...)`
3. 429 区分提示；WS task-finish 埋点
4. 单请求上限（413）
5. 面板策略页加另外 3 个阈值字段、`voice.conf` 播种默认值（含 `RATE_LIMIT_BACKEND`）
6. 测试：三类计量口径、窗口滑动、单请求上限、网关提示音类型、Redis 降级到内存

## 九、与配额的关系 / 未来扩展

- 本方案的计量口径与 `API_KEY_QUOTA_DESIGN.md` 完全对齐（llm_tokens / asr_seconds / tts_chars），将来配额落库可直接复用同一套埋点。
- 配额是**周期总量**（月），限流是**分钟速率**——先做限流跑稳，配额等 `usage_records` 落库后再上。
- 外部用户自助生成 key（`owner_type` / `owner_id` 已预留）：套餐就是这套阈值的周期版本。

**同步/异步边界**：限流的"判断 + 扣减 + 窗口累加"必须同步（内存微秒级 / Redis Lua 一次往返），
否则并发下拦不住；**落库统计与 429 审计异步**（复用 `client_ip_audit_middleware` 的
`asyncio.to_thread` 模式，失败不影响业务响应）。`usage_records` 定位是统计展示而非计费权威，
丢几条可接受；真正要准的配额走批量队列 + 事务，二期再做。

## 十、待确认

- 网关侧"用量超限"提示音要不要单独做（需改 gateway 的失败类型）
- LLM 回退字符估算的 `estimated=true` 是否计入限流（建议计入但标记，避免拿不到 usage 时完全不限）
- 默认策略阈值（100req / 20k token / 300s / 50k 字符）是否合适，需观察实际用量
