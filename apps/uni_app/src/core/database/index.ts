import { createPlusSqliteDatabase } from './plusSqlite'
import type { SqlDatabase } from './types'

let instance: SqlDatabase | null = null

/** 全局单例：首次使用时创建，避免每个 feature 各开一个连接 */
export function getDatabase(): SqlDatabase {
  if (!instance) instance = createPlusSqliteDatabase()
  return instance
}

/** 测试或替换实现时注入；传 null 恢复默认 */
export function setDatabase(database: SqlDatabase | null): void {
  instance = database
}

export { createPlusSqliteDatabase } from './plusSqlite'
export { bindSql, toSqlLiteral } from './sql'
export type { SqlDatabase, SqlDatabaseOptions } from './types'
