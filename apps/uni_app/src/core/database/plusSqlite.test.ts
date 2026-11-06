import { describe, expect, it } from 'vitest'
import { createPlusSqliteDatabase } from './plusSqlite'

describe('plus sqlite adapter', () => {
  it('非 App 环境标记为不支持', () => {
    expect(createPlusSqliteDatabase().isSupported()).toBe(false)
  })

  it('不支持时 open 不抛错，方便统一初始化', async () => {
    await expect(createPlusSqliteDatabase().open()).resolves.toBeUndefined()
  })

  it('不支持时查询给出明确错误，而不是静默返回空', async () => {
    await expect(createPlusSqliteDatabase().query('SELECT 1')).rejects.toThrow(
      '当前端不支持 SQLite'
    )
  })
})
