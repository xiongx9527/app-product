import { describe, it, expect } from 'vitest'
import { createToolkit, registerMcpServers } from './index'
import { createAgentService } from '../agentService'
import type { McpServerConfig } from '../../protocol'

/**
 * registerMcpServers 的健壮性：非法配置项被跳过且不抛错（避免单个坏配置拖垮整个会话）。
 * 真实 stdio / http 服务器的连通性留给手动 E2E，这里只验证「坏配置不致命」与空列表不报错。
 */
describe('registerMcpServers', () => {
  it('空服务器列表返回空且不抛', async () => {
    const toolkit = createToolkit('zh-CN')
    const before = toolkit.getJSONSchemas().length
    const clients = await registerMcpServers(toolkit, [])
    expect(clients).toEqual([])
    // 没有注册任何新工具
    expect(toolkit.getJSONSchemas().length).toBe(before)
  })

  it('stdio 缺 command 被跳过且不抛', async () => {
    const toolkit = createToolkit('zh-CN')
    const servers: McpServerConfig[] = [
      { name: 'bad-stdio', transport: 'stdio' }, // 缺 command
    ]
    const clients = await registerMcpServers(toolkit, servers)
    expect(clients).toEqual([])
  })

  it('sse / http 缺 url 被跳过且不抛', async () => {
    const toolkit = createToolkit('zh-CN')
    const servers: McpServerConfig[] = [
      { name: 'bad-sse', transport: 'sse' }, // 缺 url
      { name: 'bad-http', transport: 'http' }, // 缺 url
    ]
    const clients = await registerMcpServers(toolkit, servers)
    expect(clients).toEqual([])
  })

  it('连接不存在的 stdio 服务器被超时/错误捕获，跳过且不抛', async () => {
    const toolkit = createToolkit('zh-CN')
    const servers: McpServerConfig[] = [
      { name: 'unreachable', transport: 'stdio', command: 'this-command-does-not-exist-xyz' },
    ]
    const clients = await registerMcpServers(toolkit, servers)
    expect(clients).toEqual([])
  })
})

/**
 * createAgentService 在带 mcpServers 时：
 *  - 仍正常返回 AgentService；
 *  - 暴露 mcpClients 数组（无服务器时为空）；
 *  - closeMcp() 可调用且不抛（无资源可释放）。
 */
describe('createAgentService 带 mcpServers', () => {
  it('无 MCP 服务器时 mcpClients 为空且 closeMcp 可调用', async () => {
    const agent = await createAgentService(
      { llm: { provider: 'stub', baseUrl: '', model: '', apiKey: '', params: {} } },
      'zh-CN'
    )
    expect(Array.isArray(agent.mcpClients)).toBe(true)
    expect(agent.mcpClients).toEqual([])
    await expect(agent.closeMcp()).resolves.toBeUndefined()
  })

  it('stub 模型也返回空 mcpClients 且 closeMcp 不抛', async () => {
    const agent = await createAgentService(
      { llm: { provider: 'stub', baseUrl: '', model: '', apiKey: '', params: {} } },
      'zh-CN',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ name: 'ignored', transport: 'stdio', command: 'nope' }] // 非法项被跳过，不影响构造
    )
    expect(agent.mcpClients).toEqual([])
    await expect(agent.closeMcp()).resolves.toBeUndefined()
  })
})
