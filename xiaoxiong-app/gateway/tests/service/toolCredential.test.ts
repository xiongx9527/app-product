import { describe, it, expect } from 'vitest'
import { toolPrefix, injectCredential } from '../../src/service/toolCredential'
import type { AccountCredential } from '../../src/mapper/accountMapper'

const pwdCred: AccountCredential = {
  type: 'askdata', name: '问数', kind: 'password',
  username: 'admin', password: 'SQLBot@123456', apiKey: '',
}
const keyCred: AccountCredential = {
  type: 'svc', name: '某服务', kind: 'apikey',
  username: '', password: '', apiKey: 'sk-abc123',
}

describe('toolPrefix：工具名前缀 = 账号 type', () => {
  it('askdata__access_token → askdata', () => {
    expect(toolPrefix('askdata__access_token')).toBe('askdata')
  })
  it('无 __ 前缀返回空串（内置工具不注入）', () => {
    expect(toolPrefix('current_location')).toBe('')
  })
  it('不同工具前缀不同（系统通用，不写死 askdata）', () => {
    expect(toolPrefix('github__list_repos')).toBe('github')
    expect(toolPrefix('foo__bar__baz')).toBe('foo')
  })
})

describe('injectCredential：按 type 取到的凭据注入工具参数', () => {
  it('账号密码型：填入 username/password', () => {
    const r = injectCredential('{}', pwdCred)
    expect(r.injected).toBe(true)
    expect(JSON.parse(r.input)).toEqual({ username: 'admin', password: 'SQLBot@123456' })
  })

  it('不覆盖 LLM 已填的值', () => {
    const r = injectCredential(JSON.stringify({ username: 'other', password: 'typed' }), pwdCred)
    expect(JSON.parse(r.input)).toEqual({ username: 'other', password: 'typed' })
    expect(r.injected).toBe(false)
  })

  it('API Key 型：填 apiKey', () => {
    const r = injectCredential(undefined, keyCred)
    expect(JSON.parse(r.input).apiKey).toBe('sk-abc123')
  })

  it('按 schema 字段白名单过滤（additionalProperties:false 不报错）', () => {
    // 工具只接受 query，不接受凭据字段 → 不注入，input 原样
    const r = injectCredential('{"query":"x"}', pwdCred, ['query'])
    expect(r.injected).toBe(false)
    expect(JSON.parse(r.input)).toEqual({ query: 'x' })
  })

  it('只填 schema 允许的凭据字段', () => {
    const r = injectCredential('{}', pwdCred, ['username', 'password', 'other'])
    expect(JSON.parse(r.input)).toEqual({ username: 'admin', password: 'SQLBot@123456' })
  })

  it('无凭据时不注入，input 保持合法 JSON', () => {
    const r = injectCredential('{"query":"x"}', null)
    expect(r.injected).toBe(false)
    expect(JSON.parse(r.input)).toEqual({ query: 'x' })
  })

  it('非法 input 字符串不抛错，按空对象处理', () => {
    const r = injectCredential('not-json', pwdCred)
    expect(JSON.parse(r.input)).toEqual({ username: 'admin', password: 'SQLBot@123456' })
  })
})
