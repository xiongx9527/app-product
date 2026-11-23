# 语音代理（19529）数据库结构

`model-proxy/voice/` 这套本地语音/LLM 代理用到三套存储，职责不同：

| 存储 | 定位 | 实现文件 | 是否必配 |
|---|---|---|---|
| **本地 SQLite `voice.db`** | 配置的**真相源**（配置、凭据、目录、纠错词表、审计、会话） | `voice/voice_db.py`、`voice/voice_correction_store.py` | 是，默认启用 |
| **远端 Postgres** | 远程库（配置同步主体 + 纠错词表），可选 | `voice/voice_sync.py`、`voice/voice_correction_store.py` | 否（`VOICE_REMOTE_DSN`） |
| **Redis** | 远端缓存（配置读缓存、纠错词表缓存），透明降级 | `voice/voice_sync.py`、`voice/voice_correction_store.py` | 否（`REDIS_URL`） |

所有存储都是**可选远程**：远程未配 / 驱动没装 / 连不上时全部透明降级为纯本地 SQLite，读写不报错，只是不做远程同步/缓存。

路径与环境变量（完整注释见 `voice/voice.conf.example`）：

- 运行目录 `VOICE_HOME`（默认 `~/.app-product/voice`）
- 本地库 `$VOICE_DB_DIR/voice.db`（`VOICE_DB_DIR` 默认 `$VOICE_HOME`，也可 `VOICE_DB_PATH` 直接指定）
- 远程 `VOICE_REMOTE_DSN`（Postgres）、`VOICE_PG_DSN`（纠错表 Postgres）、`REDIS_URL`
- 配置优先级：命令行参数 > 环境变量 > 本地 SQLite（真相源）> voice.conf > 内置默认值

## 一、本地 SQLite 表结构（`voice.db`）

建表统一在 `voice_db.py:ensure_schema()`（`CREATE TABLE IF NOT EXISTS`，幂等）。所有时间列都是毫秒级整数时间戳。

### 1. 配置与运维类

**`config_kv`** — 配置的真相源（管理面板保存的配置落这里）

| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 配置键 |
| value | TEXT | 配置值 |
| updated_at | INTEGER NOT NULL | 最近修改时间 |
| updated_by | TEXT | 最近修改者（审计用，v2 补） |

**`events`** — 运行事件流

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| ts | INTEGER NOT NULL | 时间 |
| level | TEXT NOT NULL DEFAULT 'info' | 级别 |
| source | TEXT | 来源 |
| message | TEXT NOT NULL | |
| meta | TEXT | JSON 附加信息（v2 补） |

索引 `idx_events_ts(ts)`；保留上限 5000 条（`_MAX_EVENTS`）。

**`audit`** — 配置变更审计

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| ts | INTEGER NOT NULL | 时间 |
| actor | TEXT | 谁 |
| action | TEXT NOT NULL | 动作 |
| detail | TEXT | 改了什么 |

索引 `idx_audit_ts(ts)`；保留上限 5000 条（`_MAX_AUDIT`）。

**`health_snapshots`** — 健康快照历史

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| ts | INTEGER NOT NULL | 时间 |
| payload | TEXT | `/health` 的 JSON 快照 |

索引 `idx_health_ts(ts)`。

**`admin_sessions`** — 管理员登录会话（落库后跨重启 / 多实例一致）

| 列 | 类型 | 说明 |
|---|---|---|
| token | TEXT PK | 会话 token |
| username | TEXT NOT NULL | |
| created_at | INTEGER NOT NULL | 创建时间 |
| expires_at | INTEGER NOT NULL | 过期时间（TTL 8h，`SESSION_TTL`） |

索引 `idx_sessions_exp(expires_at)`。

**`admin_credentials`** — v9 旧表单行表（v10 起保留只读兼容、不再写入）；存量账号已迁入 `admin_users`。

**`admin_users`**（v10 新增）— 管理面板多账号 + 角色，**不写 `config_kv`**（密码不进远端）

| 列 | 类型 | 说明 |
|---|---|---|
| username | TEXT PK | 账号名 |
| password | TEXT NOT NULL | 密码明文（本地库，不引 hash 依赖） |
| role | TEXT NOT NULL DEFAULT 'viewer' | viewer / operator / admin |
| enabled | INTEGER NOT NULL DEFAULT 1 | 禁用后会话立即失效 |
| is_builtin | INTEGER NOT NULL DEFAULT 0 | 内置管理员（不可删/改角色/禁用/被重置密码，只能自改）；部分唯一索引保证最多一个 |
| updated_at | INTEGER NOT NULL | 最近修改（秒） |

**`admin_api_keys`**（v10 新增）— API Key 哈希管理，**只存哈希不存明文**

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| key_hash | TEXT NOT NULL UNIQUE | `sha256(token)[:16]` |
| key_prefix | TEXT NOT NULL | 明文前 8 字符，仅展示 |
| name | TEXT NOT NULL DEFAULT '' | 备注名 |
| enabled | INTEGER NOT NULL DEFAULT 1 | |
| not_before | INTEGER | 生效开始（秒 epoch，NULL=不限） |
| expires_at | INTEGER | 失效时间（秒 epoch，NULL=不限） |
| allowed_ips | TEXT NOT NULL DEFAULT '[]' | JSON 数组，单 IP/CIDR；空=不额外限制 |
| owner_type / owner_id | TEXT NOT NULL DEFAULT '' | 为将来外部用户自助管理预留，本期不用 |
| created_at / updated_at | INTEGER NOT NULL | 秒 |

鉴权两层 IP 叠加：全局 `VOICE_IP_ALLOW` 与 key 级 `allowed_ips` 都过才放行；key 级为空=不限。鉴权开关三态：显式 on/off，未设置时表内有 enabled key 即开启。旧 `VOICE_API_KEY` 配置/auto key 文件存量迁移一次进表后不再参与鉴权（迁移标记 `api_keys_migrated` 存 `config_kv`）。

**`rate_policies`**（v11 新增）— 限流策略（阈值模板，仅按 api-key）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| name | TEXT NOT NULL UNIQUE | 策略名 |
| description | TEXT | 备注 |
| req_per_min | INTEGER NOT NULL | 次数/min |
| llm_tokens_per_min / asr_seconds_per_min / tts_chars_per_min | INTEGER NOT NULL | 三类计量阈值/min |
| enabled | INTEGER NOT NULL DEFAULT 1 | 停用用于灰度 |
| is_default | INTEGER NOT NULL DEFAULT 0 | 默认标记，**允许多个** |
| is_builtin | INTEGER NOT NULL DEFAULT 0 | 内置策略（唯一、不可删/禁），没绑策略的 Key 用它兜底；部分唯一索引保证最多一条 |
| period | TEXT NOT NULL DEFAULT 'minute' | 限流单位：minute/hour/day/week/month；阈值含义随单位变 |
| created_at / updated_at | INTEGER NOT NULL | 秒 |

**`rate_policy_bindings`**（v11 新增）— key ↔ 策略多对多

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| key_id | INTEGER NOT NULL | → admin_api_keys.id ON DELETE CASCADE |
| policy_id | INTEGER NOT NULL | → rate_policies.id ON DELETE CASCADE |
| UNIQUE(key_id, policy_id) | | 同一 key 不重复绑同一策略 |

一个 key 可绑多策略，取每维阈值最小值（最严格）；无绑定/全停用 → 用默认策略。限流只由**全局开关** `RATE_LIMIT_ENABLED`（voice.conf/安全设置页）控制：开 → 所有 key 按绑定策略限流（没绑用默认），关 → 全部放行；没有 per-key 开关（v12 已删除该列）。计数在 `rate_store`（内存/Redis 由配置决定），不落库。数据统计/审计仍保留 IP 与 key 身份（`audit.actor`），与限流无关。

**`schema_version`** — 表结构变更留痕

| 列 | 类型 | 说明 |
|---|---|---|
| version | INTEGER PK | 版本号 |
| applied_at | INTEGER | 应用时间 |
| description | TEXT | 该版本做了什么（v7 补） |

### 2. 目录类（音色 / 模型，由 seed 维护，保存配置不写这两张）

**`voices`** — 音色目录，供 `/voice/v1/audio/voices` 查询

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 音色 id（如 `zh-CN-XiaoxiaoNeural`） |
| provider | TEXT NOT NULL DEFAULT 'builtin' | 提供商 |
| model | TEXT NOT NULL DEFAULT '' | 所属模型 |
| desc_zh / desc_en | TEXT | 中英描述 |
| sort | INTEGER NOT NULL DEFAULT 0 | 排序 |
| is_default | INTEGER NOT NULL DEFAULT 0 | 默认标记 |

索引 `idx_voices_pm(provider, model)`。数据由 `voice/seed/*.json` + `init_catalog.py` 幂等灌入。

**`speech_models`** — ASR / TTS 模型目录（全量官方目录）

| 列 | 类型 | 说明 |
|---|---|---|
| kind | TEXT NOT NULL | `stt` / `tts` |
| provider | TEXT NOT NULL | 提供商 |
| protocol | TEXT NOT NULL DEFAULT '' | 调用形态线协议 `http` / `ws` / `http-async`（不含厂商名，v5 补） |
| model | TEXT NOT NULL | 模型名 |
| is_default | INTEGER NOT NULL DEFAULT 0 | 每 provider 一个默认 |
| sort | INTEGER NOT NULL DEFAULT 0 | 排序 |

主键 `(kind, provider, model)`，索引 `idx_speech_models_kp(kind, provider)`。与 `voices` 配合：`voices.(provider, model)` 指向本表。**只由 seed / init_catalog.py 维护，保存动作绝不写它。**

**`enabled_speech_models`** — 实际启用（用户勾选）的模型（v6 新增）

| 列 | 类型 | 说明 |
|---|---|---|
| kind / provider / model | TEXT NOT NULL | 同 speech_models |
| is_default | INTEGER NOT NULL DEFAULT 0 | |
| sort | INTEGER NOT NULL DEFAULT 0 | |

主键 `(kind, provider, model)`，索引 `idx_enabled_models_kp(kind, provider)`。**与基础库严格分离**：保存配置时按 `(kind, provider)` 整体替换本表，取消勾选即删除行。`kokoro` 是后上线的内置 TTS，存量库靠 `_seed_enabled_from_config` 无条件补一行（见 `voice_db.py`）。

### 3. ASR 纠错词表（`asr_corrections` / `asr_correction_variants`）

所有客户端共享的纠错词表**权威源**（`learn_correction` 工具写入，网关静默同步）。两表结构在三个地方各有一份定义，字段要保持一致：

- `voice_db.py:ensure_schema()` — 基础列
- `voice_correction_store.py:_SqliteBackend.ensure_schema()` — **完整列**（含扩展列）
- `voice_correction_store.py` 的 PG / 旧库补列路径

**`asr_corrections`**（主表：正确词，唯一）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| correct | TEXT NOT NULL UNIQUE | 正确词 |
| pinyin | TEXT NOT NULL DEFAULT '' | 正确词拼音 |
| note | TEXT | 备注 |
| device_id | TEXT | 来源设备（扩展列） |
| source | TEXT NOT NULL DEFAULT 'local' | 来源（扩展列） |
| reviewed | INTEGER NOT NULL DEFAULT 0 | 是否审核通过（扩展列） |
| enabled | INTEGER NOT NULL DEFAULT 1 | 是否启用（扩展列） |
| source_id | INTEGER | 来源 id（扩展列） |
| created_at | INTEGER | 创建时间（扩展列） |
| updated_at | INTEGER NOT NULL | 更新时间 |

**`asr_correction_variants`**（变体表：错词，与主表一对多）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| correction_id | INTEGER NOT NULL | 主表 id，`FOREIGN KEY → asr_corrections(id) ON DELETE CASCADE` |
| wrong | TEXT NOT NULL | 错词（识别错的文本） |
| pinyin | TEXT NOT NULL DEFAULT '' | 错词拼音，**匹配用它** |
| note / device_id / source / reviewed / enabled / source_correction_id / source_id / created_at / updated_at | 同上扩展列 | |

唯一约束 `(correction_id, wrong)`；索引 `idx_asr_variants_cid(correction_id)`、`idx_asr_variants_pinyin(pinyin)`、`idx_acv_pinyin(pinyin)`、`idx_acv_updated(updated_at)`。

同步时联表摊平成 `{wrong, pinyin, correct}` 下发；对外只暴露审核通过且启用的条目。存储后端可选 `sqlite` / `postgresql`（`VOICE_CORRECTION_DB` 显式指定，否则按 `VOICE_REMOTE_DSN` scheme 推断），Redis 做缓存、透明降级。

## 二、版本变更（schema_version）

`voice_db.py` 的 `SCHEMA_VERSION` 与 `SCHEMA_CHANGES` 维护版本留痕，`ensure_schema()` 后由 `_migrate()` 逐级补列（幂等，重复启动安全）：

| 版本 | 变更 |
|---|---|
| v1 | 初始：config_kv / events / audit / health_snapshots / admin_sessions |
| v2 | config_kv 加 updated_by；events 加 meta |
| v3 | 新增 voices 音色目录 |
| v4 | 新增 speech_models 模型目录 |
| v5 | speech_models 加 protocol |
| v6 | 新增 enabled_speech_models（启用表与基础库分离） |
| v7 | schema_version 加 description；补齐 v1~v6 历史说明 |
| v8 | 新增 asr_corrections + asr_correction_variants 纠错词表 |
| v9 | 新增 admin_credentials 管理面板凭据表（独立表，不进 config_kv）；SCHEMA_VERSION 常量与 SCHEMA_CHANGES 对齐 |
| v10 | 新增 admin_users（多账号+角色+内置标记）与 admin_api_keys（哈希+时间窗口+IP 绑定+owner 预留）两表；存量账号/api-key 幂等迁移 |
| v11 | 新增 rate_policies + rate_policy_bindings 两表（限流策略，仅按 key）；幂等播种默认策略 |
| v12 | 删除 admin_api_keys.rate_limit_enabled 列（per-key 开关废弃，限流改由全局开关 + 策略绑定控制） |
| v13 | rate_policies 加 is_builtin 列（内置兜底策略、不可删/禁）；is_default 允许多个 |
| v14 | rate_policies 加 period 列（限流单位 minute/hour/day/week/month，默认 minute） |

> 完整可执行 DDL 见 `model-proxy/schema.sql`（含本地 SQLite / 远端 Postgres / Redis KEY 三段）。
> v8 及之前的历史：纠错两表由 `ensure_schema()` 的 `CREATE TABLE IF NOT EXISTS` 直接建出，
> 版本留痕由补录逻辑写入。v9 起 `SCHEMA_VERSION` 常量与 `SCHEMA_CHANGES` 版本严格对齐。

## 三、远端 Postgres（`voice_sync.py`）

与本地 SQLite 同构，只做**配置同步主体**（`config_kv`）+ 日志预留（`events` / `audit`），不存目录/纠错表：

- `config_kv(key TEXT PK, value TEXT, updated_at BIGINT NOT NULL, updated_by TEXT)`
- `events(id BIGSERIAL PK, ts BIGINT NOT NULL, level, source, message, meta TEXT)`
- `audit(id BIGSERIAL PK, ts BIGINT NOT NULL, actor, action, detail TEXT)`

**账号 / API Key 表（v10，结构同本地、可按需开启同步）**：运行时仍以本地 SQLite 为准（安全边界）；schema 已对齐 Postgres，将来开启同步时可直连。哈希可逆性低、明文永不落任何库：

- `admin_users(username TEXT PK, password TEXT, role TEXT, enabled INTEGER, is_builtin INTEGER, updated_at BIGINT)` — 部分唯一索引 `UNIQUE(is_builtin) WHERE is_builtin=1`
- `admin_api_keys(id BIGSERIAL PK, key_hash TEXT UNIQUE, key_prefix TEXT, name TEXT, enabled INTEGER, not_before BIGINT, expires_at BIGINT, allowed_ips TEXT, owner_type TEXT, owner_id TEXT, created_at BIGINT, updated_at BIGINT)`

推送：`push_config()` 把本地全量配置 upsert 到 Postgres 并写穿 Redis；拉取走反向路径。依赖 `asyncpg`（未装则跳过远程）。

## 四、Redis（`voice_sync.py` / `voice_correction_store.py`）

- 配置缓存 key：`voice:config_cache`（`voice_sync.py:_REDIS_KEY`）
- 纠错词表也有一层 Redis 缓存（`voice_correction_store._RedisCache`）
- 连接失败按 `_REDIS_RETRY` 间隔退避，不反复重试；未配 / 未装 / 连不上全部透明降级

## 维护提示

- 新增表 / 列：`ensure_schema()` 加幂等 DDL，`SCHEMA_VERSION` +1 并在 `SCHEMA_CHANGES` 登记说明（**别再漏登记导致版本与变更表不一致**）；纠错表若要改列，记得三个定义处同步。
- 查询实际库结构：`sqlite3 $VOICE_HOME/voice.db '.schema'`；看版本留痕：`SELECT * FROM schema_version ORDER BY version`。
- 目录数据（音色 / 模型）只放 `voice/seed/*.json`，由 `init_catalog.py` 幂等灌库，禁止硬编码在业务代码。
