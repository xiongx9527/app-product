import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'

export type AppDb = NodeSQLiteDatabase

// 用 require 加载 node:sqlite 而非静态 import：Vite 5 的静态 import 扫描会把
// 较新的 node: 内置模块误处理，导致测试 transform 阶段报错；require 不被静态分析，
// 运行时仍交给 Node 原生加载，行为与 import 一致。
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

/**
 * 建表引导（DDL）。
 *
 * 说明：drizzle-kit 的 generate/push 在 node:sqlite 的 rc 工具链下有内部报错
 * （`_sqliteCore.sql is not a function`，工具 bug，非业务代码问题），故此处用
 * 一条 CREATE TABLE IF NOT EXISTS 引导建表。所有业务查询仍走 Drizzle mapper，
 * 不写行级 SQL；待 drizzle-kit 修复后可改为 migrations。
 */
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE TABLE IF NOT EXISTS command_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    command TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE TABLE IF NOT EXISTS user_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  -- 唯一约束用显式索引落地：CREATE TABLE IF NOT EXISTS 不会改已有表结构，
  -- 旧库若缺这条唯一约束，onConflictDoUpdate 会因「找不到冲突目标」而报错；
  -- 用 IF NOT EXISTS 创建索引可同时覆盖「新建库」与「已存在但缺约束的旧库」。
  CREATE UNIQUE INDEX IF NOT EXISTS uq_user_memory_device_key ON user_memory(device_id, key);
  CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    config TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_app_config_device ON app_config(device_id);
`

/** 创建数据库连接（Node 内置 node:sqlite，无原生编译依赖）并引导建表。 */
export function createDb(path: string): AppDb {
  // node:sqlite 不会自动创建父目录，这里先确保目录存在（内存库跳过）。
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const sqlite = new DatabaseSync(path)
  sqlite.exec(BOOTSTRAP_SQL)
  // 旧库可能缺 created_at 列（早期 schema 只有 updated_at）；CREATE TABLE IF NOT EXISTS 不会给
  // 已有表加列，这里显式补列。注意：SQLite 的 ALTER ADD COLUMN 只允许「常量」默认值，
  // 不能写 strftime('%s','now') 这种函数默认值（会报 "Cannot add a column with non-constant default"），
  // 故加列时用 NULL 默认，旧行的 created_at 用 updated_at 兜底（与 mapper 取值逻辑一致）。
  try {
    sqlite.exec('ALTER TABLE user_memory ADD COLUMN created_at INTEGER')
    sqlite.exec('UPDATE user_memory SET created_at = updated_at WHERE created_at IS NULL')
  } catch {
    // 列已存在，无需处理
  }
  return drizzle({ client: sqlite })
}
