import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

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

/**
 * ASR 纠错词表（全局共享，不分设备）——两张表，主表维护热词，字表维护错词。
 *
 * 主表 asr_corrections：一个热词（正确词）+ 它的拼音 + 描述/备注。correct 唯一。
 * 字表 asr_correction_variants：某热词下的错词字 + 错词拼音（一对多，correction_id 外键）。
 *  例：主表「李存勖 / li cun cun xu」；字表「李存序/li cun xu」「李存须/li cun xu」…
 *
 * 匹配：输入片段转拼音 → 字表找 pinyin 相同的错词 → 经 correction_id 取主表 correct
 *      → 命中的 correct 全一致才纠（shi li 命中多个不同 correct → 不纠，防误伤）。
 * enabled=0 软删除，可回溯。
 */
export const asrCorrections = sqliteTable(
  'asr_corrections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    correct: text('correct').notNull(), // 正确热词
    pinyin: text('pinyin').notNull(), // 正确词的无声调拼音
    note: text('note'), // 备注/描述（如「歌手」「诗词名」）
    enabled: integer('enabled').notNull().default(1),
    // 来源：local=本地 learn_correction 学的、synced=从 9529 同步的。与上传状态无关。
    source: text('source').notNull().default('local'),
    /** 上传标识：0=待上传 9529，1=已上传/从9529拉回。 */
    uploaded: integer('uploaded').notNull().default(0),
    /** 来源 id：9529 侧对应记录的主表 id（synced 时有值），用于对账/幂等。 */
    sourceId: integer('source_id'),
    createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
  },
  (t) => ({ uniq: uniqueIndex('uq_asr_correction').on(t.correct) })
)

/** 字表：每个热词下的错词（wrong 字 + 拼音），一个热词可有多个错词。 */
export const asrCorrectionVariants = sqliteTable(
  'asr_correction_variants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    correctionId: integer('correction_id').notNull().references(() => asrCorrections.id),
    wrong: text('wrong').notNull(), // 错词字（如「李存序」）
    pinyin: text('pinyin').notNull(), // 错词的无声调拼音
    note: text('note'), // 备注（如来源/实机失误场景）
    enabled: integer('enabled').notNull().default(1),
    // 来源：local=本地 learn_correction 学的、synced=从 9529 同步的。与上传状态无关。
    source: text('source').notNull().default('local'),
    /** 上传标识：0=待上传 9529（本地学的），1=已上传/从9529拉回（无需再传）。 */
    uploaded: integer('uploaded').notNull().default(0),
    /** 9529 侧主表 id（synced 时有值），与本地 correctionId 对应。 */
    sourceCorrectionId: integer('source_correction_id'),
    /** 9529 侧变体 id（synced 时有值），用于对账/幂等。 */
    sourceId: integer('source_id'),
    createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
  },
  (t) => ({
    uniq: uniqueIndex('uq_asr_correction_variant').on(t.correctionId, t.wrong),
    // 匹配路径是「输入拼音 → 找 pinyin 相同的错词」，pinyin 上建普通索引避免全表扫描
    byPinyin: index('idx_asr_variant_pinyin').on(t.pinyin),
  })
)

export type SessionRow = typeof sessions.$inferSelect
export type CommandLogRow = typeof commandLogs.$inferSelect
export type UserMemoryRow = typeof userMemory.$inferSelect
export type AppConfigRow = typeof appConfig.$inferSelect
export type AsrCorrectionRow = typeof asrCorrections.$inferSelect
