import { describe, it, expect } from 'vitest'
import { enhanceToolDescriptions } from '../../src/service/toolDescEnhancer'

describe('工具描述增强：工具自己告诉 LLM 凭据怎么用，不写死业务', () => {
  it('有 access_token 工具且目标工具带 token 入参 → 描述补充凭据说明', () => {
    const tools = [
      { name: 'askdata__access_token', description: '换 token', inputSchema: { properties: { username: {}, password: {} } } },
      { name: 'askdata__mcp_datasource_list', description: '列数据源', inputSchema: { properties: { token: {} } } },
    ]
    const enhanced = enhanceToolDescriptions(tools)
    expect(enhanced).toContain('askdata__mcp_datasource_list')
    expect(tools[1].description).toContain('askdata__access_token')
    expect(tools[1].description).toContain('token')
  })

  it('无 token 入参的工具不增强', () => {
    const tools = [
      { name: 'askdata__access_token', description: '换 token', inputSchema: { properties: {} } },
      { name: 'askdata__server_info', description: '探针', inputSchema: { properties: {} } },
    ]
    expect(enhanceToolDescriptions(tools)).toEqual([])
  })

  it('不写死业务名：任意前缀都生效', () => {
    const tools = [
      { name: 'github__access_token', description: '换 token', inputSchema: { properties: {} } },
      { name: 'github__list_repos', description: '列仓库', inputSchema: { properties: { token: {} } } },
    ]
    const enhanced = enhanceToolDescriptions(tools)
    expect(enhanced).toContain('github__list_repos')
    expect(tools[1].description).toContain('github__access_token')
  })

  it('access_token 工具自身不增强', () => {
    const tools = [
      { name: 'foo__access_token', description: '换 token', inputSchema: { properties: { token: {} } } },
      { name: 'foo__do', description: '做事', inputSchema: { properties: { token: {} } } },
    ]
    const enhanced = enhanceToolDescriptions(tools)
    expect(enhanced).not.toContain('foo__access_token')
    expect(tools[0].description).toBe('换 token')
  })
})
