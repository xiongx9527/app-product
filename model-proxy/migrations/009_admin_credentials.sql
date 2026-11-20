-- =============================================================================
-- 迁移 009 —— 管理面板凭据表 admin_credentials
--
-- 用途：鉴权加固（消除默认 admin/admin），把账号密码收敛到本地 SQLite。
--   首次启动表为空时的初始值来源优先级：
--     1) voice.conf 的 ADMIN_USER / ADMIN_PASSWORD（显式配置，推荐）
--     2) 存量 admin.conf（老用户平滑迁移）
--     3) 都没有则随机生成，启动日志打印一次
--   之后真相源是这张表，改配置文件不再生效。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=9 / SCHEMA_CHANGES[9] / ensure_schema）
-- 完整结构说明：model-proxy/schema.sql、model-proxy/DB_SCHEMA.md
--
-- 适用存储：仅本地 SQLite voice.db（默认 ~/.app-product/voice/voice.db）。
--           远端 Postgres / Redis 本次不涉及、也绝不放管理员密码。
--
-- 幂等性：全部 IF NOT EXISTS / INSERT OR IGNORE，可重复执行，不删改任何存量数据
--         （config_kv / admin_sessions / audit / 目录表 / 纠错表一律不动）。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含本 DDL，正常重启即可；
--   2) 手工补迁移：sqlite3 ~/.app-product/voice/voice.db < migrations/009_admin_credentials.sql
-- =============================================================================

-- 1) 凭据表：单行，id 固定为 1
CREATE TABLE IF NOT EXISTS admin_credentials (
    id         INTEGER PRIMARY KEY CHECK(id = 1),
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2) 版本留痕（v9）。applied_at 用毫秒级时间戳；INSERT OR IGNORE 保证重复执行不覆盖。
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    9,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    '新增 admin_credentials 表：管理面板账号密码（独立表，不写 config_kv，避免被 voice_sync 推到远端 Postgres/Redis）；SCHEMA_VERSION 常量与 SCHEMA_CHANGES 版本对齐'
);

-- 3) 验证（可选，手工执行时可看结果）
-- SELECT version, description FROM schema_version ORDER BY version;
-- SELECT id, username, length(password) AS pw_len, updated_at FROM admin_credentials;
