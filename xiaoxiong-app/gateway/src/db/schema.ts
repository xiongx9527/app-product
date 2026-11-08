import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * 数据库表结构（Drizzle schema）。表定义即源码，迁移 SQL 由 drizzle-kit 生成，
 * 不手写为应用代码。对应 AGENTS.md 提到的三类本地数据：会话记录、设备数据、命令日志。
 */
export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
})

export const deviceData = sqliteTable('device_data', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id'),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
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
    updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
  },
  // 同设备下 (device_id, key) 唯一：save 用 ON CONFLICT 覆盖更新，去重不堆积。
  (t) => ({ uniq: uniqueIndex('uq_user_memory_device_key').on(t.deviceId, t.key) })
)

export type SessionRow = typeof sessions.$inferSelect
export type DeviceDataRow = typeof deviceData.$inferSelect
export type CommandLogRow = typeof commandLogs.$inferSelect
export type UserMemoryRow = typeof userMemory.$inferSelect
