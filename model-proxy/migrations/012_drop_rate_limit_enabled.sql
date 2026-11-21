-- =============================================================================
-- 迁移 012 —— 删除废弃的 per-key 限流开关列
--
-- 用途：v11 曾给 admin_api_keys 加 rate_limit_enabled 列（per-key 限流开关）。
--       v12 改为只由全局 RATE_LIMIT_ENABLED + 策略绑定控制，该列废弃，删除。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=12 / SCHEMA_CHANGES[12] / _migrate）
-- 设计说明：model-proxy/RATE_LIMIT_DESIGN.md
--
-- 幂等性：先判断列存在再 DROP（SQLite 3.35+ 支持 DROP COLUMN；老版本跳过，列留着但代码不再读写，无害）。
--   不删任何数据：绑定关系在 rate_policy_bindings 表，不受影响。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含该迁移，正常重启即可；
--   2) 手工补迁移：sqlite3 ~/.app-product/voice/voice.db < migrations/012_drop_rate_limit_enabled.sql
-- =============================================================================

-- 1) 删除废弃列（幂等：仅当列存在时执行）
--    SQLite 3.35+：
ALTER TABLE admin_api_keys DROP COLUMN rate_limit_enabled;

-- 老版本 SQLite（<3.35）不支持 DROP COLUMN，上面的语句会报错。
-- 这种情况可跳过——代码已不再读写该列，物理存在无害。
-- 若一定要删（SQLite 老版本）：重建表并拷贝数据，此处不提供（避免误操作丢数据）。

-- 2) 版本留痕（v12）
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    12,
    CAST(strftime('%s', 'now') AS INTEGER),
    '删除 admin_api_keys.rate_limit_enabled 列（per-key 开关废弃，限流改由全局开关 + 策略绑定控制）'
);

-- 3) 验证（可选）
-- SELECT version, description FROM schema_version ORDER BY version;
-- PRAGMA table_info(admin_api_keys);   -- 应无 rate_limit_enabled 行
