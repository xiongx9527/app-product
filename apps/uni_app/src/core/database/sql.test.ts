import { describe, expect, it } from 'vitest'
import { bindSql, toSqlLiteral } from './sql'

describe('sql literal', () => {
  it('字符串会转义单引号，避免拼坏 SQL', () => {
    expect(toSqlLiteral("it's")).toBe("'it''s'")
  })

  it('数字、布尔、空值按 SQL 语义输出', () => {
    expect(toSqlLiteral(42)).toBe('42')
    expect(toSqlLiteral(true)).toBe('1')
    expect(toSqlLiteral(false)).toBe('0')
    expect(toSqlLiteral(null)).toBe('NULL')
    expect(toSqlLiteral(undefined)).toBe('NULL')
    expect(toSqlLiteral(Number.NaN)).toBe('NULL')
  })

  it('按顺序替换 ? 占位符', () => {
    expect(
      bindSql('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 2])
    ).toBe("INSERT INTO t (a, b) VALUES ('x', 2)")
  })

  it('没有参数时原样返回，不误伤 SQL 里的问号', () => {
    expect(bindSql('SELECT * FROM t WHERE a = ?')).toBe(
      'SELECT * FROM t WHERE a = ?'
    )
  })

  it('参数不足时剩余占位符变成 NULL', () => {
    expect(bindSql('VALUES (?, ?)', [1])).toBe('VALUES (1, NULL)')
  })
})
