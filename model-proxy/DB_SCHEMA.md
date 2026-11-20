# 语音代理（9529）数据库结构

`model-proxy/voice/` 这套本地语音/LLM 代理用到三套存储，职责不同：

| 存储 | 定位 | 实现文件 | 是否必配 |
|---|---|---|---|
| **本地 SQLite `voice.db`** | 配置的**真相源**（配置、目录、纠错词表、审计、会话） | `voice/voice_db.py`、`voice/voice_correction_store.py` | 是，默认启用 |
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

> **注意**：代码中 `SCHEMA_VERSION = 7`（`voice_db.py:78`），但 `SCHEMA_CHANGES` 已登记到 v8（含纠错两表）。v8 的两张表由 `ensure_schema()` 的 `CREATE TABLE IF NOT EXISTS` 直接建出，迁移留痕的 v8 行由补录逻辑写入；`SCHEMA_VERSION` 常量的这个滞后不影响建表，但读版本常量时别以为最新是 v7。

## 三、远端 Postgres（`voice_sync.py`）

与本地 SQLite 同构，只做**配置同步主体**（`config_kv`）+ 日志预留（`events` / `audit`），不存目录/纠错表：

- `config_kv(key TEXT PK, value TEXT, updated_at BIGINT NOT NULL, updated_by TEXT)`
- `events(id BIGSERIAL PK, ts BIGINT NOT NULL, level, source, message, meta TEXT)`
- `audit(id BIGSERIAL PK, ts BIGINT NOT NULL, actor, action, detail TEXT)`

推送：`push_config()` 把本地全量配置 upsert 到 Postgres 并写穿 Redis；拉取走反向路径。依赖 `asyncpg`（未装则跳过远程）。

## 四、Redis（`voice_sync.py` / `voice_correction_store.py`）

- 配置缓存 key：`voice:config_cache`（`voice_sync.py:_REDIS_KEY`）
- 纠错词表也有一层 Redis 缓存（`voice_correction_store._RedisCache`）
- 连接失败按 `_REDIS_RETRY` 间隔退避，不反复重试；未配 / 未装 / 连不上全部透明降级

## 维护提示

- 新增表 / 列：`ensure_schema()` 加幂等 DDL，`SCHEMA_VERSION` +1 并在 `SCHEMA_CHANGES` 登记说明（**别再漏登记导致版本与变更表不一致**）；纠错表若要改列，记得三个定义处同步。
- 查询实际库结构：`sqlite3 $VOICE_HOME/voice.db '.schema'`；看版本留痕：`SELECT * FROM schema_version ORDER BY version`。
- 目录数据（音色 / 模型）只放 `voice/seed/*.json`，由 `init_catalog.py` 幂等灌库，禁止硬编码在业务代码。
