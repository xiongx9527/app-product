-- =============================================================================
-- 迁移 011 —— 限流策略（按 api-key，策略驱动）
--
-- 用途：schema v11。新增 rate_policies / rate_policy_bindings 两表，admin_api_keys
--       加 rate_limit_enabled 列（默认 0=不限流）。默认策略由代码 ensure_schema 幂等播种。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=11 / SCHEMA_CHANGES[11] / ensure_schema）
-- 完整设计：model-proxy/RATE_LIMIT_DESIGN.md；结构说明：schema.sql / DB_SCHEMA.md
--
-- 适用存储：本地 SQLite voice.db（默认 ~/.app-product/voice/voice.db）。
--   运行时限流计数在应用内存（或可选 Redis），不落库；本表只存策略定义与绑定关系。
-- 幂等性：全部 IF NOT EXISTS / INSERT OR IGNORE，可重复执行，不删改任何存量数据。
--   存量 api-key 加列默认 0（不限流），行为不变。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含本 DDL，正常重启即可；
--   2) 手工补迁移：sqlite3 ~/.app-product/voice/voice.db < migrations/011_rate_limit.sql
-- =============================================================================

-- 1) api-key 加限流开关列（老库补列；SQLite 用 ALTER 幂等需手工判断，服务启动会自动补）
-- ALTER TABLE admin_api_keys ADD COLUMN rate_limit_enabled INTEGER NOT NULL DEFAULT 0;

-- 2) 限流策略表
CREATE TABLE IF NOT EXISTS rate_policies (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    req_per_min         INTEGER NOT NULL,
    llm_tokens_per_min  INTEGER NOT NULL,
    asr_seconds_per_min INTEGER NOT NULL,
    tts_chars_per_min   INTEGER NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    is_default          INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_policies_default
    ON rate_policies(is_default) WHERE is_default = 1;

-- 3) key ↔ 策略绑定
CREATE TABLE IF NOT EXISTS rate_policy_bindings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id    INTEGER NOT NULL REFERENCES admin_api_keys(id) ON DELETE CASCADE,
    policy_id INTEGER NOT NULL REFERENCES rate_policies(id) ON DELETE CASCADE,
    UNIQUE(key_id, policy_id)
);

-- 4) 版本留痕（v11）
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    11,
    CAST(strftime('%s', 'now') AS INTEGER),
    '新增 rate_policies + rate_policy_bindings 两表（限流策略，仅按 key）；admin_api_keys 加 rate_limit_enabled 列；幂等播种默认策略'
);

-- 5) 远端 Postgres 同构 DDL（备将来按需同步；运行时仍以本地为准）
-- CREATE TABLE IF NOT EXISTS rate_policies (
--     id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
--     req_per_min INTEGER NOT NULL, llm_tokens_per_min INTEGER NOT NULL,
--     asr_seconds_per_min INTEGER NOT NULL, tts_chars_per_min INTEGER NOT NULL,
--     enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
--     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_policies_default
--     ON rate_policies(is_default) WHERE is_default = 1;
-- CREATE TABLE IF NOT EXISTS rate_policy_bindings (
--     id BIGSERIAL PRIMARY KEY,
--     key_id INTEGER NOT NULL REFERENCES admin_api_keys(id) ON DELETE CASCADE,
--     policy_id INTEGER NOT NULL REFERENCES rate_policies(id) ON DELETE CASCADE,
--     UNIQUE(key_id, policy_id));

-- 6) 验证（可选）
-- SELECT version, description FROM schema_version ORDER BY version;
-- .schema rate_policies
-- .schema rate_policy_bindings
