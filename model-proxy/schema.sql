-- =============================================================================
-- 9529 语音代理 —— 三套存储的表结构
--
-- 三套存储定位（见 DB_SCHEMA.md）：
--   1) 本地 SQLite voice.db  : 配置 / 凭据 / 目录 / 词表的真相源（必配）
--   2) 远端 PostgreSQL        : 配置同步主体 + 日志预留（可选，VOICE_REMOTE_DSN）
--   3) Redis                  : 配置 / 词表缓存（可选，REDIS_URL），无关系表，仅 KEY
--
-- 本文件为结构说明快照：建表统一由代码里 *.py 的 CREATE TABLE IF NOT EXISTS 幂等执行
-- （voice_db.py / voice_sync.py / voice_correction_store.py），不要手工建库。
-- v10 用户管理 / API Key：运行时以本地 SQLite 为准（安全边界）；下方 Postgres 段已
-- 给出同构建表语句，将来可按需开启同步。哈希可逆性低可同步，明文永不落任何库。
-- =============================================================================


-- #############################################################################
-- 1) 本地 SQLite —— voice.db（真相源，必配）
--    路径：$VOICE_HOME/voice.db（VOICE_HOME 默认 ~/.app-product/voice）
--    所有时间列均为毫秒级整数时间戳。建表在 voice_db.py:ensure_schema()。
-- #############################################################################

-- 版本留痕
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER,
    description TEXT
);

-- 配置真相源（管理面板保存的配置落这里；注意：不含管理员密码）
CREATE TABLE IF NOT EXISTS config_kv (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);

-- 运行事件流
CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    level   TEXT NOT NULL DEFAULT 'info',
    source  TEXT,
    message TEXT NOT NULL,
    meta    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

-- 配置变更 / 登录审计（含 admin_login_failed / admin_login_success）
CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    actor   TEXT,
    action  TEXT NOT NULL,
    detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

-- 健康快照历史
CREATE TABLE IF NOT EXISTS health_snapshots (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_ts ON health_snapshots(ts);

-- 管理员登录会话（落库后可跨重启 / 多实例一致）
CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON admin_sessions(expires_at);

-- 管理面板账号密码（v9 旧表单行表；v10 起保留只读兼容、不再写入）
CREATE TABLE IF NOT EXISTS admin_credentials (
    id         INTEGER PRIMARY KEY CHECK(id = 1),
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 【v10 新增】管理多账号 + 角色（真相源，不写 config_kv）
CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer',   -- viewer / operator / admin
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,       -- 内置管理员：不可删/改角色/禁用/被重置密码
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
    ON admin_users(is_builtin) WHERE is_builtin = 1;

-- 【v10 新增】API Key（只存哈希，不存明文）
CREATE TABLE IF NOT EXISTS admin_api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash    TEXT NOT NULL UNIQUE,            -- sha256(明文)[:16]
    key_prefix  TEXT NOT NULL,                   -- 明文前 8 字符，仅展示
    name        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    not_before  INTEGER,                         -- 生效开始（秒，NULL=不限）
    expires_at  INTEGER,                         -- 失效（秒，NULL=不限）
    allowed_ips TEXT NOT NULL DEFAULT '[]',      -- JSON 数组：单 IP/CIDR，空=不限
    owner_type  TEXT NOT NULL DEFAULT '',        -- 外部用户预留
    owner_id    TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON admin_api_keys(key_hash);

-- 音色目录（由 seed/*.json + init_catalog.py 幂等灌入，保存配置不写它）
CREATE TABLE IF NOT EXISTS voices (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL DEFAULT 'builtin',
    model      TEXT NOT NULL DEFAULT '',
    desc_zh    TEXT,
    desc_en    TEXT,
    sort       INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voices_pm ON voices(provider, model);

-- ASR / TTS 模型目录（全量官方目录，只由 seed 维护）
CREATE TABLE IF NOT EXISTS speech_models (
    kind       TEXT NOT NULL,               -- stt / tts
    provider   TEXT NOT NULL,
    protocol   TEXT NOT NULL DEFAULT '',    -- 线协议 http / ws / http-async
    model      TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(kind, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_speech_models_kp ON speech_models(kind, provider);

-- 实际启用的模型（用户勾选），与基础库严格分离
CREATE TABLE IF NOT EXISTS enabled_speech_models (
    kind       TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(kind, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_enabled_models_kp ON enabled_speech_models(kind, provider);

-- ASR 纠错词表：正确词（权威源）
CREATE TABLE IF NOT EXISTS asr_corrections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    correct    TEXT NOT NULL UNIQUE,
    pinyin     TEXT NOT NULL DEFAULT '',
    note       TEXT,
    device_id  TEXT,
    source     TEXT NOT NULL DEFAULT 'local',
    reviewed   INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    source_id  INTEGER,
    created_at INTEGER,
    updated_at INTEGER NOT NULL
);

-- ASR 纠错词表：错词变体（与主表一对多，匹配用 pinyin）
CREATE TABLE IF NOT EXISTS asr_correction_variants (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_id       INTEGER NOT NULL REFERENCES asr_corrections(id) ON DELETE CASCADE,
    wrong               TEXT NOT NULL,
    pinyin              TEXT NOT NULL DEFAULT '',
    note                TEXT,
    device_id           TEXT,
    source              TEXT NOT NULL DEFAULT 'local',
    reviewed            INTEGER NOT NULL DEFAULT 0,
    enabled             INTEGER NOT NULL DEFAULT 1,
    source_correction_id INTEGER,
    source_id           INTEGER,
    created_at          INTEGER,
    updated_at          INTEGER NOT NULL,
    UNIQUE(correction_id, wrong)
);
CREATE INDEX IF NOT EXISTS idx_asr_variants_cid   ON asr_correction_variants(correction_id);
CREATE INDEX IF NOT EXISTS idx_asr_variants_pinyin ON asr_correction_variants(pinyin);
CREATE INDEX IF NOT EXISTS idx_acv_pinyin          ON asr_correction_variants(pinyin);
CREATE INDEX IF NOT EXISTS idx_acv_updated         ON asr_correction_variants(updated_at);


-- #############################################################################
-- 2) 远端 PostgreSQL —— 可选（VOICE_REMOTE_DSN / VOICE_PG_DSN）
--    建表在 voice_sync.py:_ensure_schema() 与 voice_correction_store.py 的 PG 后端。
--    v10 账号 / API Key 表结构已对齐（同本地），运行时仍以本地为准；可按需开启同步。
-- #############################################################################

-- 配置同步主体（与本地 config_kv 同构，按 updated_at 合并）
CREATE TABLE IF NOT EXISTS config_kv (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at BIGINT NOT NULL,
    updated_by TEXT
);

-- 集中日志预留
CREATE TABLE IF NOT EXISTS events (
    id      BIGSERIAL PRIMARY KEY,
    ts      BIGINT NOT NULL,
    level   TEXT,
    source  TEXT,
    message TEXT,
    meta    TEXT
);

CREATE TABLE IF NOT EXISTS audit (
    id     BIGSERIAL PRIMARY KEY,
    ts     BIGINT NOT NULL,
    actor  TEXT,
    action TEXT,
    detail TEXT
);

-- v10 账号 / API Key（结构同本地，可按需开启同步；明文永不落库）
CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer',
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
    ON admin_users(is_builtin) WHERE is_builtin = 1;

CREATE TABLE IF NOT EXISTS admin_api_keys (
    id          BIGSERIAL PRIMARY KEY,
    key_hash    TEXT NOT NULL UNIQUE,
    key_prefix  TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    not_before  BIGINT,
    expires_at  BIGINT,
    allowed_ips TEXT NOT NULL DEFAULT '[]',
    owner_type  TEXT NOT NULL DEFAULT '',
    owner_id    TEXT NOT NULL DEFAULT '',
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON admin_api_keys(key_hash);

-- 纠错词表可选 PG 存储（VOICE_CORRECTION_DB=postgresql 时）
CREATE TABLE IF NOT EXISTS asr_corrections (
    id         BIGSERIAL PRIMARY KEY,
    correct    TEXT NOT NULL UNIQUE,
    pinyin     TEXT NOT NULL DEFAULT '',
    note       TEXT,
    device_id  TEXT,
    source     TEXT NOT NULL DEFAULT 'local',
    reviewed   INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    source_id  BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS asr_correction_variants (
    id                  BIGSERIAL PRIMARY KEY,
    correction_id       BIGINT NOT NULL REFERENCES asr_corrections(id) ON DELETE CASCADE,
    wrong               TEXT NOT NULL,
    pinyin              TEXT NOT NULL DEFAULT '',
    note                TEXT,
    device_id           TEXT,
    source              TEXT NOT NULL DEFAULT 'local',
    reviewed            INTEGER NOT NULL DEFAULT 0,
    enabled             INTEGER NOT NULL DEFAULT 1,
    source_correction_id BIGINT,
    source_id           BIGINT,
    created_at          BIGINT NOT NULL,
    updated_at          BIGINT NOT NULL,
    UNIQUE(correction_id, wrong)
);
CREATE INDEX IF NOT EXISTS idx_acv_pinyin  ON asr_correction_variants(pinyin);
CREATE INDEX IF NOT EXISTS idx_acv_updated ON asr_correction_variants(updated_at);


-- #############################################################################
-- 3) Redis —— 可选缓存（REDIS_URL），无关系表，仅以下 KEY（均为 JSON 字符串）
--    v10 账号 / API Key 不进 Redis 缓存（鉴权每次直查本地库保证即时生效；明文永不落缓存）
-- #############################################################################
--   KEY                       TTL(秒)  值                          来源
--   voice:config_cache        60      全量配置 JSON                voice_sync.py
--   asr:corrections:all       30      全量纠错词表 JSON            voice_correction_store.py
--
-- 连接失败 / 未配 / 未装依赖时全部透明降级为直读本地 SQLite，读写不报错。
