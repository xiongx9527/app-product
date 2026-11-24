import { describe, it, expect, afterEach } from 'vitest'
import {
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  isDashscopeVoiceValid,
  resolveDashscopeVoice,
  listTtsVoices,
} from '../../src/service/ttsVoices'
import { DashScopeWsTts } from '../../src/tts/dashscopeWs'

/**
 * 锁住「音色必须属于所选模型」这条官方约束，防止再出现「有回答却没播报」：
 * 旧 v1 音色（longxiang）或编造的 _v3 id 配 v3 模型，云端会回 418 Invalid voice，
 * 网关补静音 → 客户端无声。这里保证这类脏音色一律收敛到该模型的默认音色。
 */
describe('百炼 TTS 音色与模型同源（避免 418 Invalid voice 静音）', () => {
  it('默认音色属于 v3-flash 合法目录', () => {
    expect(DASHSCOPE_DEFAULT_VOICE).toBe('longyumi_v3')
    expect(isDashscopeVoiceValid(DASHSCOPE_DEFAULT_MODEL, DASHSCOPE_DEFAULT_VOICE)).toBe(true)
  })

  it('旧 v1 音色 longxiang 配 v3 模型 → 回退默认音色', () => {
    expect(isDashscopeVoiceValid('cosyvoice-v3-flash', 'longxiang')).toBe(false)
    expect(resolveDashscopeVoice('cosyvoice-v3-flash', 'longxiang')).toBe(DASHSCOPE_DEFAULT_VOICE)
  })

  it('编造 / 错标音色（longshao_v3、longyingbing、longanpei）→ 回退默认音色', () => {
    for (const v of ['longshao_v3', 'longyingbing', 'longanpei']) {
      expect(isDashscopeVoiceValid('cosyvoice-v3-flash', v)).toBe(false)
      expect(resolveDashscopeVoice('cosyvoice-v3-flash', v)).toBe(DASHSCOPE_DEFAULT_VOICE)
    }
  })

  it('合法 v3 音色保持原样（标杆 / 语音助手 / 方言 / 出海）', () => {
    for (const v of ['longanyang', 'longyumi_v3', 'longanyue_v3', 'loongabby_v3', 'longhuhu_v3']) {
      expect(resolveDashscopeVoice('cosyvoice-v3-flash', v)).toBe(v)
    }
  })

  it('v3-plus 与 v3-flash 共用同一套音色', () => {
    expect(resolveDashscopeVoice('cosyvoice-v3-plus', 'longxiang')).toBe(DASHSCOPE_DEFAULT_VOICE)
    expect(resolveDashscopeVoice('cosyvoice-v3-plus', 'longanyang')).toBe('longanyang')
  })

  it('未知模型不拦截，交云端判定（不误伤未来模型）', () => {
    expect(resolveDashscopeVoice('cosyvoice-v2', 'longwan_v2')).toBe('longwan_v2')
  })

  it('目录里每条音色都带 model 且能通过合法性校验（目录即唯一真相源）', async () => {
    const list = await listTtsVoices('dashscope')
    expect(list.defaultVoice).toBe(DASHSCOPE_DEFAULT_VOICE)
    expect(list.defaultModel).toBe(DASHSCOPE_DEFAULT_MODEL)
    expect(list.voices.length).toBeGreaterThan(10)
    for (const v of list.voices) {
      expect(v.model).toBe(DASHSCOPE_DEFAULT_MODEL)
      expect(isDashscopeVoiceValid(v.model, v.value)).toBe(true)
    }
  })

  it('DashScopeWsTts 实例把陈旧音色收敛为默认音色（真正进 run-task 的值）', () => {
    // 复现线上脏配置：voice=longxiang（v1 音色）、没带 model。
    const tts = new DashScopeWsTts(
      'https://dashscope.aliyuncs.com',
      { voice: 'longxiang' },
      'dummy-key',
    )
    // private 字段只做只读断言，验证收敛确实作用到了实例，而非只停在纯函数层。
    const internal = tts as unknown as { model: string; voice: string }
    expect(internal.model).toBe(DASHSCOPE_DEFAULT_MODEL)
    expect(internal.voice).toBe(DASHSCOPE_DEFAULT_VOICE)
  })
})

/**
 * 内置音色目录必须来自 9529 的 /voice/v1/audio/voices（voice.db / seed 维护、含 desc_zh /
 * desc_en），网关只做中转、不再写死一份编造目录；9529 不可达时回退降级清单。
 */
describe('内置 TTS 音色目录中转 9529（与真实引擎同源，不再另写一份）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('正常：9529 返回的真实目录透传给前端，含中英文描述', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/voice/v1/audio/voices')) {
        return new Response(
          JSON.stringify({
            default: 'zh-CN-XiaoxiaoNeural',
            provider: 'builtin',
            model: 'edge-tts',
            protocol: 'http',
            voices: [
              { id: 'zh-CN-XiaoxiaoNeural', provider: 'builtin', model: 'edge-tts', desc_zh: '女声·温柔自然（默认）', desc_en: 'Female · gentle and natural (default)', is_default: true },
              { id: 'ja-JP-NanamiNeural', provider: 'builtin', model: 'edge-tts', desc_zh: '女声·柔和', desc_en: 'Female · soft', is_default: false },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const list = await listTtsVoices('builtin', 'zh-CN', { voiceBuiltinUrl: 'http://127.0.0.1:9529' })
    expect(list.protocol).toBe('http')
    expect(list.defaultVoice).toBe('zh-CN-XiaoxiaoNeural')
    expect(list.defaultModel).toBe('edge-tts')
    expect(list.voices.length).toBe(2)
    expect(list.voices[0].value).toBe('zh-CN-XiaoxiaoNeural')
    expect(list.voices[0].descZh).toBe('女声·温柔自然（默认）')
    expect(list.voices[0].descEn).toBe('Female · gentle and natural (default)')
  })

  it('音色目录请求不带 provider(用 9529 当前实际提供商)，选了 model 才带 model', async () => {
    let seenUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url)
      return new Response(
        JSON.stringify({ default: 'stella', provider: 'deepseek', model: 'deepseek-tts', voices: [{ id: 'stella', model: 'deepseek-tts' }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    // 没选 model：URL 不带 provider、也不带 model
    await listTtsVoices('builtin', 'zh-CN', { voiceBuiltinUrl: 'http://127.0.0.1:9529' })
    expect(seenUrl).not.toContain('provider=')
    expect(seenUrl).not.toContain('model=')
    // 选了 model：URL 带 model
    await listTtsVoices('builtin', 'zh-CN', { voiceBuiltinUrl: 'http://127.0.0.1:9529', model: 'deepseek-tts' })
    expect(seenUrl).toContain('model=deepseek-tts')
    expect(seenUrl).not.toContain('provider=')
  })

  it('9529 开启鉴权：带 api-key 时把 Bearer 头透传给音色目录接口', async () => {
    let seenAuth = ''
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/voice/v1/audio/voices')) {
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
        return new Response(
          JSON.stringify({
            default: 'zh-CN-XiaoxiaoNeural',
            model: 'edge-tts',
            voices: [{ id: 'zh-CN-XiaoxiaoNeural', model: 'edge-tts', is_default: true }],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const list = await listTtsVoices('builtin', 'zh-CN', {
      voiceBuiltinUrl: 'http://127.0.0.1:9529',
      apiKey: 'secret',
    })
    expect(seenAuth).toBe('Bearer secret')
    expect(list.defaultVoice).toBe('zh-CN-XiaoxiaoNeural')
  })

  it('9529 不可达：回退降级清单，避免设置页空下拉', async () => {
    globalThis.fetch = (async () => {
      throw new Error('conn refused')
    }) as unknown as typeof fetch

    const list = await listTtsVoices('builtin', 'zh-CN', { voiceBuiltinUrl: 'http://127.0.0.1:9529' })
    // 降级清单非空，且每条第带中英文描述
    expect(list.voices.length).toBeGreaterThan(0)
    for (const v of list.voices) {
      expect(v.value).toBeTruthy()
      expect(v.descZh).toBeTruthy()
      expect(v.descEn).toBeTruthy()
    }
  })
})
