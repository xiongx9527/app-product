import { describe, it, expect, vi, afterEach } from 'vitest'
import { summarizeProvider, buildHealth, clearProbeCache } from './health'
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
 * 真实服务形态：OpenAI 兼容语音服务根路径返回 404，但真正的转写/合成端点
 * （/v1/audio/transcriptions、/v1/audio/speech）返回 200 且内容合法。
 * 旧实现只 GET 根路径、把「任何响应（含 404）」都当可达，导致 ASR/TTS 明明挂了却误报绿色——
 * 新实现对每个能力做功能性探测：ASR 真发音频看能否回合法 JSON、TTS 真发文本看能否回非空音频。
 * 这里锁住新行为：真实端点 200 且内容合法 ⇒ 可用；端点 5xx/连不上 ⇒ 不可用（不再误报绿色）。
 */
function stubFetch(
  handler: (url: string, method: string) => { status: number; body?: string } | null,
) {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const r = handler(url, init?.method ?? 'GET')
      if (!r) throw new Error('network error')
      const buf = r.body ? new TextEncoder().encode(r.body) : new Uint8Array(0)
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 400,
        async text() {
          return r.body ?? ''
        },
        async arrayBuffer() {
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        },
      } as unknown as Response
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearProbeCache()
})

const CONFIG: GatewayConfig = {
  asr: { provider: 'whisper', baseUrl: 'http://192.168.1.100:9529' },
  llm: { provider: 'ollama', baseUrl: 'http://192.168.1.100:11434' },
  tts: { provider: 'edge', baseUrl: 'http://192.168.1.100:9529' },
} as unknown as GatewayConfig

describe('buildHealth：ASR/TTS 功能性探测，根路径不再决定判定', () => {
  it('ASR/TTS 真实端点 200 且内容合法 ⇒ reachable=true（修复只看根路径的误判）', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/v1/audio/transcriptions') && method === 'POST')
        return { status: 200, body: JSON.stringify({ text: '' }) }
      if (url.endsWith('/v1/audio/speech') && method === 'POST')
        return { status: 200, body: 'x'.repeat(100) } // > 44 字节，视为非空音频
      if (url.includes('baidu.com') || url.includes('bilibili.com')) return { status: 200 }
      if (url.includes('/api/tags') || url.includes('/v1/models')) return { status: 200 } // LLM 兜底探测
      return { status: 404 }
    })
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(true)
    expect(h.tts.reachable).toBe(true)
    expect(h.llm.reachable).toBe(true)
  })

  it('ASR 真实端点 5xx（上游挂掉，根路径仍 404）⇒ reachable=false，不再误报绿色', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/v1/audio/transcriptions') && method === 'POST') return { status: 502 }
      if (url.endsWith('/v1/audio/speech') && method === 'POST')
        return { status: 200, body: 'x'.repeat(100) }
      if (url.includes('baidu.com') || url.includes('bilibili.com')) return { status: 200 }
      if (url.includes('/api/tags') || url.includes('/v1/models')) return { status: 200 }
      return { status: 404 }
    })
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(false)
    expect(h.tts.reachable).toBe(true)
    expect(h.llm.reachable).toBe(true)
  })

  it('服务连不上（fetch 抛错）⇒ reachable=false', async () => {
    stubFetch(() => null)
    const h = await buildHealth(CONFIG)
    expect(h.asr.reachable).toBe(false)
    expect(h.tts.reachable).toBe(false)
    expect(h.llm.reachable).toBe(false)
  })
})

describe('buildHealth：deep 模式 LLM 未选模型不得假绿', () => {
  const dashscopeVoice = (model: string) =>
    ({ provider: 'dashscope', url: 'https://llm-x.maas.aliyuncs.com', apiKey: 'k', model }) as unknown as import('../voiceConfig').VoiceConfig

  it('未选模型：即使主机可达，也不得报 reachable=true（避免假绿）', async () => {
    stubFetch(() => ({ status: 200 })) // 主机通，但没模型
    const h = await buildHealth(CONFIG, dashscopeVoice(''), true)
    expect(h.llm.reachable).toBe(false)
    expect(h.llm.message).toContain('未选择模型')
  })

  it('选了模型：真正调用 /chat/completions，连通 200 ⇒ reachable=true', async () => {
    stubFetch((url) => {
      if (url.includes('/chat/completions')) return { status: 200, body: '{}' }
      return { status: 200 }
    })
    const h = await buildHealth(CONFIG, dashscopeVoice('qwen-plus'), true)
    expect(h.llm.reachable).toBe(true)
    expect(h.llm.message).toContain('已接入')
  })
})
