import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAgentService } from './agentService'

/**
 * 真实验证「当前播放曲目注入 LLM 上下文」：用 mock 的 OpenAI 兼容服务（仅本地 http）收下
 * AgentScope 发来的系统提示，断言其中含有正在播放的歌名；并让 mock 基于该上下文回一句含歌名的回答，
 * 证明助手「知道现在播的是什么歌」。不走真实大模型、不联网。
 */
describe('当前播放曲目注入 LLM 上下文', () => {
  let server: http.Server
  let baseURL = ''
  let capturedSystem = ''
  let capturedUser = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          messages?: Array<{ role: string; content: unknown }>
        }
        const textOf = (c: unknown): string => {
          if (typeof c === 'string') return c
          if (Array.isArray(c)) return c.map((b: unknown) => (typeof b === 'string' ? b : ((b as { text?: string })?.text ?? ''))).join('')
          return ''
        }
        const msgs = body.messages ?? []
        capturedSystem = textOf(msgs.find((m) => m.role === 'system')?.content)
        capturedUser = textOf(msgs.find((m) => m.role === 'user')?.content)
        // 基于收到的系统提示决定回答：能拿到歌名就回一句含歌名的话，证明上下文被模型看见
        const song = capturedSystem.includes('稻香') ? '稻香' : '未知歌曲'
        const payload = JSON.stringify({ choices: [{ delta: { content: `现在播放的是${song}。` } }] })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.end(`data: ${payload}\n\n` + 'data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    baseURL = `http://127.0.0.1:${port}/v1`
  })

  afterAll(() => {
    server?.close()
  })

  it('reply 时把当前曲目拼进系统提示，模型据此答出歌名', async () => {
    const agent = await createAgentService(
      { llm: { provider: 'builtin', baseUrl: baseURL, model: 'test', apiKey: 'x', params: {} }, timeZone: 'Asia/Shanghai' },
      'zh-CN',
      () => null,
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
      // getNowPlaying：模拟「正在播放 周杰伦《稻香》」
      () => ({ title: '稻香', artist: '周杰伦' })
    )

    let reply = ''
    await agent.reply('现在播的什么歌', (delta) => {
      reply += delta
    })

    // 1) 模型收到的系统提示里包含正在播放的歌（注入生效）
    expect(capturedSystem).toContain('稻香')
    expect(capturedSystem).toContain('周杰伦')
    expect(capturedSystem).toContain('正在播放')
    // 2) 用户问题被正确转发
    expect(capturedUser).toContain('现在播的什么歌')
    // 3) 模型基于上下文答出了歌名（而非「不知道」）
    expect(reply).toContain('稻香')
  })

  it('没有在播放时（getNowPlaying 返回 null）不注入任何曲目上下文', async () => {
    const agent = await createAgentService(
      { llm: { provider: 'builtin', baseUrl: baseURL, model: 'test', apiKey: 'x', params: {} }, timeZone: 'Asia/Shanghai' },
      'zh-CN',
      () => null,
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
      () => null
    )

    await agent.reply('你好', () => {})
    expect(capturedSystem).not.toContain('稻香')
    expect(capturedSystem).not.toContain('现在播')
  })
})
