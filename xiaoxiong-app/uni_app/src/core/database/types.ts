/**
 * 本地数据存储抽象。
 *
 * 配置这类小而同步的数据走 uni storage；
 * 设备数据、会话记录、命令日志这类会持续增长的数据走 SQLite。
 *
 * App（Android / iOS）：plus.sqlite。
 * H5 开发阶段 / 其它非 App 端：plus.sqlite 不可用，isSupported() 为 false，
 *   调用方应降级（内存或 uni storage），不要让业务崩掉。
 */
export interface SqlDatabase {
  readonly name: string
  isSupported(): boolean
  open(): Promise<void>
  execute(sql: string, args?: unknown[]): Promise<void>
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T[]>
  /** 多条语句按顺序执行，失败自动回滚 */
  transaction(statements: Array<{ sql: string; args?: unknown[] }>): Promise<void>
  close(): Promise<void>
}

export interface SqlDatabaseOptions {
  name?: string
  /** App 端数据库文件路径，默认 _doc/app_product.db */
  path?: string
}
