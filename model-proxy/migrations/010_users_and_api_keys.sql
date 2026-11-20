-- =============================================================================
-- 迁移 010 —— 用户管理（多账号 + 角色）与 API Key 表管理
--
-- 用途：v9 的单行 admin_credentials 升级为多账号 admin_users；新增 admin_api_keys
--       哈希管理表。运行时以本地 SQLite 为准；下方 Postgres DDL 备将来按需同步。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=10 / SCHEMA_CHANGES[10] / ensure_schema）
-- 完整结构说明：model-proxy/schema.sql、model-proxy/DB_SCHEMA.md
--
-- 适用存储：本地 SQLite voice.db（默认 ~/.app-product/voice/voice.db）。
-- 幂等性：全部 IF NOT EXISTS / INSERT OR IGNORE，可重复执行，不删改任何存量数据。
--        存量 admin_credentials 行迁入 admin_users（内置管理员）由代码 _migrate_admin_users()
--        完成——本脚本不重复灌数据，只补表结构；账号/api-key 数据迁移在首次启动时执行。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含本 DDL，正常重启即可；
--   2) 手工补迁移：sqlite3 ~/.app-product/voice/voice.db < migrations/010_users_and_api_keys.sql
-- =============================================================================

-- 1) 多账号 + 角色（本地 SQLite）
CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer',
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
    ON admin_users(is_builtin) WHERE is_builtin = 1;

-- 2) API Key（哈希管理）
CREATE TABLE IF NOT EXISTS admin_api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash    TEXT NOT NULL UNIQUE,
    key_prefix  TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    not_before  INTEGER,
    expires_at  INTEGER,
    allowed_ips TEXT NOT NULL DEFAULT '[]',
    owner_type  TEXT NOT NULL DEFAULT '',
    owner_id    TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON admin_api_keys(key_hash);

-- 3) 版本留痕（v10）
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    10,
    CAST(strftime('%s', 'now') AS INTEGER),
    '新增 admin_users（多账号+角色+内置标记）与 admin_api_keys（哈希+时间窗口+IP 绑定+owner 预留）两表；存量账号/api-key 幂等迁移'
);

-- 4) 远端 Postgres 同构 DDL（备将来按需开启同步；运行时仍以本地为准）
-- CREATE TABLE IF NOT EXISTS admin_users (
--     username TEXT PRIMARY KEY, password TEXT NOT NULL,
--     role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
--     is_builtin INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL);
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
--     ON admin_users(is_builtin) WHERE is_builtin = 1;
-- CREATE TABLE IF NOT EXISTS admin_api_keys (
--     id BIGSERIAL PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
--     name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
--     not_before BIGINT, expires_at BIGINT, allowed_ips TEXT NOT NULL DEFAULT '[]',
--     owner_type TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '',
--     created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
-- CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON admin_api_keys(key_hash);

-- 5) 验证（可选）
-- SELECT version, description FROM schema_version ORDER BY version;
-- .schema admin_users
-- .schema admin_api_keys
