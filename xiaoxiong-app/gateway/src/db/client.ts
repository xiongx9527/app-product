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
  CREATE TABLE IF NOT EXISTS device_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
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
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(device_id, key)
  );
`

/** 创建数据库连接（Node 内置 node:sqlite，无原生编译依赖）并引导建表。 */
export function createDb(path: string): AppDb {
  // node:sqlite 不会自动创建父目录，这里先确保目录存在（内存库跳过）。
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const sqlite = new DatabaseSync(path)
  sqlite.exec(BOOTSTRAP_SQL)
  return drizzle({ client: sqlite })
}
