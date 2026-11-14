import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * 数据库表结构（Drizzle schema）。表定义即源码，迁移 SQL 由 drizzle-kit 生成，
 * 不手写为应用代码。对应 AGENTS.md 提到的本地数据：会话记录、命令日志、用户长期记忆。
 */
export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
})

export const commandLogs = sqliteTable('command_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id'),
  command: text('command').notNull(),
  result: text('result').notNull(),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
})

/**
 * 用户长期记忆：按设备维度持久化的「习惯 / 偏好 / 日程 / 重要上下文」。
 * key 是话题标签（如「作息」「喜欢的音乐」），同一设备下 (device_id, key) 唯一，
 * 重复写同一 key 即覆盖更新（去重，避免越记越乱）。value 是具体事实。
 * 仅存本机 SQLite，不上云、不跨设备同步；与 AGENTS.md 的「设备数据本地优先」一致。
 */
export const userMemory = sqliteTable(
  'user_memory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
  },
  // 同设备下 (device_id, key) 唯一：save 用 ON CONFLICT 覆盖更新，去重不堆积。
  (t) => ({ uniq: uniqueIndex('uq_user_memory_device_key').on(t.deviceId, t.key) })
)

/**
 * 客户端设置页「保存配置」落库的整份 AppConfig（JSON 字符串），按设备维度一份。
 * 保存配置时经 POST /api/admin/config 写入网关 SQLite，作为本机持久化副本
 * （本机 setStorageSync 仍是运行时真相源，网关这份用于重装恢复 / 审计 / 跨端读取）。
 */
export const appConfig = sqliteTable(
  'app_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id'),
    config: text('config').notNull(),
    updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
  },
  (t) => ({ uniq: uniqueIndex('uq_app_config_device').on(t.deviceId) })
)

export type SessionRow = typeof sessions.$inferSelect
export type CommandLogRow = typeof commandLogs.$inferSelect
export type UserMemoryRow = typeof userMemory.$inferSelect
export type AppConfigRow = typeof appConfig.$inferSelect
