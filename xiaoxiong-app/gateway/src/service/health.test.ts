import { describe, it, expect, vi, afterEach } from 'vitest'
import { summarizeProvider, buildHealth } from './health'
import type { GatewayConfig } from '../config'

describe('summarizeProvider', () => {
  it('stub：未接入真实引擎，configured=false', () => {
    const s = summarizeProvider('stub', false)
    expect(s.configured).toBe(false)
    expect(s.reachable).toBe(false)
    expect(s.provider).toBe('stub')
    expect(s.endpoint).toBeUndefined()
    expect(s.message).toContain('占位桩')
  })

  it('已接入且可达：configured=true / reachable=true，带 endpoint', () => {
    const s = summarizeProvider('whisper', true, '192.168.1.100:9529')
    expect(s.configured).toBe(true)
    expect(s.reachable).toBe(true)
    expect(s.endpoint).toBe('192.168.1.100:9529')
    expect(s.message).toContain('已接入')
  })

  it('已配置但地址不可达：configured=true / reachable=false', () => {
    const s = summarizeProvider('whisper', false, '10.0.0.1:9529')
    expect(s.configured).toBe(true)
    expect(s.reachable).toBe(false)
    expect(s.message).toContain('不可达')
  })
})

/**
 * 真实服务形态：OpenAI 兼容语音服务根路径返回 404，但 /v1/models 返回 200。
 * 旧实现把「任何响应（含 404）」都当可达，导致 ASR/TTS 明明在跑却误判——
 * 这里锁住新行为：根 404 + /v1/models 200 ⇒ 仍判为可用；全 5xx/超时 ⇒ 不可用。
 */
function stubFetch(handler: (url: string) => { status: number } | null) {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const r = handler(url)
      if (!r) throw new Error('network error')
      return { status: r.status, ok: r.status >= 200 && r.status < 400 } as Response
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

const CONFIG: GatewayConfig = {
  asr: { provider: 'whisper', baseUrl: 'http://192.168.1.100:9529' },
  llm: { provider: 'ollama', baseUrl: 'http://192.168.1.100:11434' },
  tts: { provider: 'edge', baseUrl: 'http://192.168.1.100:9529' },
} as unknown as GatewayConfig

describe('buildHealth：根路径 404 但能力路径 200 应判为可用', () => {
  it('ASR/TTS 根 404、/v1/models 200 ⇒ reachable=true（修复误判）', async () => {
    stubFetch((url) => {
      if (url.endsWith('/') || url.endsWith(':9529')) return { status: 404 }
      if (url.includes('/v1/models')) return { status: 200 }
      if (url.includes('baidu.com') || url.includes('bilibili.com')) return { status: 200 }
      return { status: 404 }
    })
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(true)
    expect(h.tts.reachable).toBe(true)
  })

  it('服务全 5xx（根与所有健康路径都失败）⇒ reachable=false，不再误报绿色', async () => {
    stubFetch(() => ({ status: 503 }))
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(false)
    expect(h.tts.reachable).toBe(false)
    expect(h.llm.reachable).toBe(false)
  })

  it('服务连不上（fetch 抛错）⇒ reachable=false', async () => {
    stubFetch(() => null)
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(false)
  })
})
