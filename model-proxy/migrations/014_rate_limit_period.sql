-- =============================================================================
-- 迁移 014 —— 限流策略时间单位可配
--
-- 用途：v14 给 rate_policies 加 period 列（minute/hour/day/week/month，默认 minute）。
--       存量策略默认 minute，行为不变；令牌桶补充速率 = 阈值/周期秒数。
-- 对应代码：voice/voice_db.py（SCHEMA_VERSION=14 / SCHEMA_CHANGES[14]）、voice/rate_store.py
--
-- 幂等性：
--   - ADD COLUMN 重复执行会报 "duplicate column name"，属正常，忽略即可（后续语句照常执行）。
--   - UPDATE ... WHERE period IS NULL 幂等；INSERT OR IGNORE 天然幂等。
--   不删数据：存量 period 默认 minute。
--
-- 执行方式（二选一）：
--   1) 随服务启动自动执行：voice_db.ensure_schema() 已包含该迁移，正常重启即可（推荐）；
--   2) 手工补迁移：
--      sqlite3 ~/.app-product/voice/voice.db < migrations/014_rate_limit_period.sql
--      若看到 "duplicate column name: period" 是重复执行的正常提示，其余语句已生效。
--
-- 注意：本脚本覆盖 v14 结构；须在 013 之后执行（或直接重启服务自动迁移）。
-- =============================================================================

-- 1) 加 period 列（已存在会报 duplicate column，忽略即可）
ALTER TABLE rate_policies ADD COLUMN period TEXT NOT NULL DEFAULT 'minute';

-- 2) 存量策略确保 period 有值（NULL → minute；ADD COLUMN 的 DEFAULT 已填，此句兜底老数据）
UPDATE rate_policies SET period='minute' WHERE period IS NULL OR period='';

-- 3) 版本留痕（v14）
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (
    14,
    CAST(strftime('%s', 'now') AS INTEGER),
    'rate_policies 加 period 列（限流单位 minute/hour/day/week/month，默认 minute）'
);

-- 4) 验证（可选）
-- SELECT name, period FROM rate_policies;
