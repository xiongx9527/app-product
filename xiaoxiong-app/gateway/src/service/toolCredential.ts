/**
 * 系统级通用能力：工具调用时按「工具名前缀」自动注入账号本凭据。
 * 工具名 `xxx__tool` → 查账号本 type=`xxx` 的凭据，把 username/password 或 apiKey
 * 合并进 input（不覆盖 LLM 已填的值）。对 LLM 透明，密码不进对话上下文。
 */

import type { AccountCredential } from '../mapper/accountMapper'

/** 取工具名前缀（`askdata__access_token` → `askdata`）；无 `__` 返回空串。 */
export function toolPrefix(name: string): string {
  const i = name.indexOf('__')
  return i > 0 ? name.slice(0, i) : ''
}

/**
 * 把凭据合并进工具 input（JSON 字符串）。返回 { input, injected }。
 * - 只填 input 里缺失/空的字段，不覆盖 LLM 已提供的值
 * - kind=password 填 username/password；kind=apikey 填 apiKey（另兼容 api_key）
 * - 凭据无对应字段值时 injected=false（不瞎塞）
 */
export function injectCredential(
  inputRaw: string | Record<string, unknown> | undefined,
  cred: AccountCredential | null,
  allowedKeys?: readonly string[],
): { input: string; injected: boolean; fields: string[] } {
  let input: Record<string, unknown> = {}
  if (typeof inputRaw === 'string') {
    try { input = JSON.parse(inputRaw || '{}') } catch { input = {} }
  } else if (inputRaw && typeof inputRaw === 'object') {
    input = { ...inputRaw }
  }
  if (!cred) return { input: JSON.stringify(input), injected: false, fields: [] }

  const pairs: Array<[string, string]> = cred.kind === 'apikey'
    ? [['apiKey', cred.apiKey], ['api_key', cred.apiKey]]
    : [['username', cred.username], ['password', cred.password]]
  const fields: string[] = []
  for (const [k, v] of pairs) {
    if (!v) continue
    if (allowedKeys && !allowedKeys.includes(k)) continue
    if (input[k] === undefined || input[k] === '') {
      input[k] = v
      fields.push(k)
    }
  }
  return { input: JSON.stringify(input), injected: fields.length > 0, fields }
}
