/**
 * 把 `?` 占位符替换成 SQL 字面量。
 *
 * plus.sqlite 的 executeSql / selectSql 不提供参数绑定，只能拼接；
 * 所有外部数据必须走这里转义，禁止直接拼字符串。
 */
export function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

export function bindSql(sql: string, args: unknown[] = []): string {
  if (!args.length) return sql
  let index = 0
  return sql.replace(/\?/g, () => toSqlLiteral(args[index++]))
}
