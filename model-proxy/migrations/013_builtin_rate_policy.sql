-- =============================================================================
-- 迁移 013 —— 限流策略支持多个默认 + 内置标识
--
-- 用途：v13 给 rate_policies 加 is_builtin 列（内置兜底策略，唯一、不可删/禁）。
--       is_default 不再唯一：默认策略可以有多个；没绑策略的 Key 用内置那条兜底。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=13 / SCHEMA_CHANGES[13] / _migrate）
--
-- 幂等性：
--   - ADD COLUMN 重复执行会报 "duplicate column name"，属正常，忽略即可（后续语句照常执行）。
--   - DROP INDEX IF EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS / 条件 UPDATE 天然幂等。
--   不删数据：现有 is_default=1 的那条会被标记为内置（如尚无内置）。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含该迁移，正常重启即可（推荐）；
--   2) 手工补迁移：
--      sqlite3 ~/.app-product/voice/voice.db < migrations/013_builtin_rate_policy.sql
--      若看到 "duplicate column name: is_builtin" 是重复执行的正常提示，其余语句已生效。
--
-- 注意：本脚本覆盖 v13 结构；如数据库落后多个版本，请按 013 → 014 顺序执行，或直接重启服务自动迁移。
-- =============================================================================

-- 1) 加 is_builtin 列（已存在会报 duplicate column，忽略即可）
ALTER TABLE rate_policies ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;

-- 2) 删旧的 is_default 唯一索引（允许多个默认）
DROP INDEX IF EXISTS idx_rate_policies_default;

-- 3) 把现有默认策略标记为内置（仅当还没有内置策略时）
UPDATE rate_policies SET is_builtin=1, is_default=1
 WHERE id=(SELECT id FROM rate_policies WHERE is_default=1 ORDER BY id LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM rate_policies WHERE is_builtin=1);

-- 4) 建 is_builtin 唯一索引（最多一个内置）
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_policies_builtin
    ON rate_policies(is_builtin) WHERE is_builtin = 1;

-- 5) 版本留痕（v13）
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    13,
    CAST(strftime('%s', 'now') AS INTEGER),
    'rate_policies 加 is_builtin 列（内置兜底策略，不可删/禁）；is_default 允许多个'
);

-- 6) 验证（可选）
-- SELECT name, is_default, is_builtin FROM rate_policies;
-- PRAGMA index_list(rate_policies);
