import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

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

export type SessionRow = typeof sessions.$inferSelect
export type DeviceDataRow = typeof deviceData.$inferSelect
export type CommandLogRow = typeof commandLogs.$inferSelect
