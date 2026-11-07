import { bindSql } from './sql'
import type { SqlDatabase, SqlDatabaseOptions } from './types'

interface PlusSqlite {
  openDatabase(options: {
    name: string
    path: string
    success?: () => void
    fail?: (error: unknown) => void
  }): void
  closeDatabase(options: {
    name: string
    success?: () => void
    fail?: (error: unknown) => void
  }): void
  executeSql(options: {
    name: string
    sql: string
    success?: () => void
    fail?: (error: unknown) => void
  }): void
  selectSql(options: {
    name: string
    sql: string
    success?: (data: unknown[]) => void
    fail?: (error: unknown) => void
  }): void
  transaction(options: {
    name: string
    operation: 'begin' | 'commit' | 'rollback'
    success?: () => void
    fail?: (error: unknown) => void
  }): void
}

function resolveSqlite(): PlusSqlite | null {
  const scope = globalThis as unknown as { plus?: { sqlite?: PlusSqlite } }
  return scope.plus?.sqlite ?? null
}

function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'SQLite 操作失败'
}

/**
 * App 端实现：uni-app 的 plus.sqlite。
 * 不支持的端（鸿蒙 / H5 / 小程序）isSupported() 为 false，
 * open() 直接返回，execute/query 抛错，由调用方决定降级策略。
 */
export function createPlusSqliteDatabase(
  options: SqlDatabaseOptions = {}
): SqlDatabase {
  const name = options.name ?? 'app_product'
  const path = options.path ?? '_doc/app_product.db'
  const sqlite = resolveSqlite()

  let opened = false
  let opening: Promise<void> | null = null

  function ensureOpen(): Promise<void> {
    if (!sqlite) return Promise.resolve()
    if (opened) return Promise.resolve()
    if (opening) return opening

    opening = new Promise<void>((resolve, reject) => {
      sqlite.openDatabase({
        name,
        path,
        success: () => {
          opened = true
          opening = null
          resolve()
        },
        fail: (error) => {
          opening = null
          reject(new Error(describeError(error)))
        },
      })
    })
    return opening
  }

  function requireSqlite(): PlusSqlite {
    if (!sqlite) throw new Error('当前端不支持 SQLite')
    return sqlite
  }

  async function execute(sql: string, args: unknown[] = []): Promise<void> {
    const api = requireSqlite()
    await ensureOpen()
    await new Promise<void>((resolve, reject) => {
      api.executeSql({
        name,
        sql: bindSql(sql, args),
        success: resolve,
        fail: (error) => reject(new Error(describeError(error))),
      })
    })
  }

  return {
    name,

    isSupported() {
      return sqlite !== null
    },

    open: ensureOpen,

    execute,

    async query<T = Record<string, unknown>>(
      sql: string,
      args: unknown[] = []
    ): Promise<T[]> {
      const api = requireSqlite()
      await ensureOpen()
      return new Promise<T[]>((resolve, reject) => {
        api.selectSql({
          name,
          sql: bindSql(sql, args),
          success: (data) => resolve((data ?? []) as T[]),
          fail: (error) => reject(new Error(describeError(error))),
        })
      })
    },

    async transaction(
      statements: Array<{ sql: string; args?: unknown[] }>
    ): Promise<void> {
      const api = requireSqlite()
      await ensureOpen()

      const operation = (
        value: 'begin' | 'commit' | 'rollback'
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          api.transaction({
            name,
            operation: value,
            success: resolve,
            fail: (error) => reject(new Error(describeError(error))),
          })
        })

      await operation('begin')
      try {
        for (const statement of statements) {
          await execute(statement.sql, statement.args)
        }
        await operation('commit')
      } catch (error) {
        try {
          await operation('rollback')
        } catch {
          // 回滚失败时保留原始错误
        }
        throw error
      }
    },

    async close(): Promise<void> {
      if (!sqlite || !opened) return
      await new Promise<void>((resolve, reject) => {
        sqlite.closeDatabase({
          name,
          success: () => {
            opened = false
            resolve()
          },
          fail: (error) => reject(new Error(describeError(error))),
        })
      })
    },
  }
}
