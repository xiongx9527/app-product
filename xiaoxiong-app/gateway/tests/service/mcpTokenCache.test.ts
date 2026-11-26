import { describe, it, expect, beforeEach } from 'vitest'
import { parseToken, setMcpToken, getMcpToken, clearMcpTokenState } from '../../src/service/mcpTokenCache'

describe('MCP token 缓存：按 type（工具前缀）隔离，不写死业务', () => {
  beforeEach(() => clearMcpTokenState())

  it('parseToken 兼容 {"token"} / {"access_token"} / 裸 token', () => {
    expect(parseToken('{"token":"abc-12345678901234"}')).toBe('abc-12345678901234')
    expect(parseToken('{"access_token":"xyz-12345678901234"}')).toBe('xyz-12345678901234')
    expect(parseToken('rawtoken1234567890')).toBe('rawtoken1234567890')
    expect(parseToken('')).toBe('')
  })

  it('不同业务前缀各自缓存，互不串号', () => {
    setMcpToken('askdata', 'token-A')
    setMcpToken('github', 'token-B')
    expect(getMcpToken('askdata')).toBe('token-A')
    expect(getMcpToken('github')).toBe('token-B')
    expect(getMcpToken('other')).toBe('')
  })

  it('短字符串/说明文字不被误当 token', () => {
    expect(parseToken('error')).toBe('')
    expect(parseToken('{"error":"bad"}')).toBe('')
  })
})
