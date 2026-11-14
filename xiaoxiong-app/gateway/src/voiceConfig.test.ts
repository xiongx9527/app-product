import { describe, it, expect } from 'vitest'
import { normalizeVoiceConfig, resolveCapabilityConfig } from './voiceConfig'
import type { GatewayConfig } from './config'
import { DashScopeWsAsr } from './asr/dashscopeWs'

/**
 * 回归：客户端下发的 params 是 ASR/LLM/TTS 共用通道，但里面混着 TTS 专用字段
 * （voice 音色、model 音色所属模型 cosyvoice-*）。若原样合并进 ASR：
 *   - model 被当成识别模型 → 云端 ModelNotFound，整句识别失败（表现为「唤醒不了」）
 *   - voice 混进 run-task parameters → InvalidParameter
 * LLM 也会把 model 当 presetGenParams 透传。这里锁住按能力分流的行为。
 */
const CONFIG = {
  llm: { provider: 'openai', model: 'qwen-plus', params: {} },
  asr: { provider: 'dashscope', endpointMs: 700, params: {} },
  tts: { provider: 'dashscope', params: {} },
  voiceDashscopeUrl: 'https://dashscope.aliyuncs.com',
  voiceBuiltinUrl: 'http://127.0.0.1:9529',
} as unknown as GatewayConfig

function dashscopeVoice() {
  return normalizeVoiceConfig({
    provider: 'dashscope',
    url: 'https://llm-x.maas.aliyuncs.com',
    apiKey: 'test-key',
    model: 'qwen-plus',
    params: { voice: 'longyumi_v3', model: 'cosyvoice-v3-flash', language: 'zh' },
  })
}

describe('resolveCapabilityConfig：TTS 专用参数不得污染 ASR / LLM', () => {
  it('dashscope：TTS 拿到完整 params，ASR / LLM 剥离 voice 与 model', () => {
    const r = resolveCapabilityConfig(dashscopeVoice(), CONFIG)
    expect(r.tts.params?.voice).toBe('longyumi_v3')
    expect(r.tts.params?.model).toBe('cosyvoice-v3-flash')

    expect(r.asr.params?.model).toBeUndefined()
    expect(r.asr.params?.voice).toBeUndefined()
    expect(r.llm.params?.model).toBeUndefined()
    expect(r.llm.params?.voice).toBeUndefined()
    // 通用参数仍要保留
    expect(r.asr.params?.language).toBe('zh')
    expect(r.llm.params?.language).toBe('zh')
    // LLM 模型走顶层 model 字段，不受 params 影响
    expect(r.llm.model).toBe('qwen-plus')
  })

  it('builtin：同样只把 voice / model 注入 TTS', () => {
    const voice = normalizeVoiceConfig({
      provider: 'builtin',
      params: { voice: 'zh-CN-XiaoxiaoNeural', model: 'edge-tts', language: 'zh' },
    })
    const r = resolveCapabilityConfig(voice, CONFIG)
    expect(r.tts.params?.voice).toBe('zh-CN-XiaoxiaoNeural')
    expect(r.asr.params?.model).toBeUndefined()
    expect(r.asr.params?.voice).toBeUndefined()
    expect(r.asr.params?.language).toBe('zh')
  })

  it('客户端没带 params：三套各自沿用网关 env 默认', () => {
    const voice = normalizeVoiceConfig({ provider: 'dashscope', url: '', apiKey: 'k' })
    const config = {
      ...CONFIG,
      asr: { provider: 'dashscope', endpointMs: 700, params: { sampleRate: 16000 } },
      tts: { provider: 'dashscope', params: { speed: 1 } },
    } as unknown as GatewayConfig
    const r = resolveCapabilityConfig(voice, config)
    expect(r.asr.params).toEqual({ sampleRate: 16000 })
    expect(r.tts.params).toEqual({ speed: 1 })
  })
})

describe('resolveCapabilityConfig：asrModel / ttsModel 独立注入对应能力', () => {
  it('显式 asrModel 注入 asr.params.model，且不污染 tts / llm', () => {
    const voice = normalizeVoiceConfig({
      provider: 'dashscope',
      url: 'https://llm-x.maas.aliyuncs.com',
      apiKey: 'k',
      model: 'qwen-plus',
      asrModel: 'fun-asr-realtime',
      ttsModel: 'cosyvoice-v3-plus',
      params: { voice: 'longyumi_v3', model: 'cosyvoice-v3-flash', language: 'zh' },
    })
    const r = resolveCapabilityConfig(voice, CONFIG)
    // ASR 拿到自己显式的模型，且通用参数保留
    expect(r.asr.params?.model).toBe('fun-asr-realtime')
    expect(r.asr.params?.language).toBe('zh')
    expect(r.asr.params?.voice).toBeUndefined()
    // TTS 显式 ttsModel 优先于音色所属模型（params.model）
    expect(r.tts.params?.model).toBe('cosyvoice-v3-plus')
    expect(r.tts.params?.voice).toBe('longyumi_v3')
    // LLM 不受影响：模型走顶层 model，params 里没有 model / voice
    expect(r.llm.model).toBe('qwen-plus')
    expect(r.llm.params?.model).toBeUndefined()
  })

  it('留空 asrModel / ttsModel：完全保持旧行为（ASR 无 model，TTS 用音色所属模型）', () => {
    const voice = normalizeVoiceConfig({
      provider: 'dashscope',
      url: '',
      apiKey: 'k',
      params: { voice: 'longyumi_v3', model: 'cosyvoice-v3-flash' },
    })
    const r = resolveCapabilityConfig(voice, CONFIG)
    expect(r.asr.params?.model).toBeUndefined()
    expect(r.tts.params?.model).toBe('cosyvoice-v3-flash')
  })

  it('只填 ttsModel、不填 asrModel：TTS 被覆盖，ASR 沿用默认（无 model）', () => {
    const voice = normalizeVoiceConfig({ provider: 'builtin', ttsModel: 'edge-tts' })
    const r = resolveCapabilityConfig(voice, CONFIG)
    expect(r.asr.params?.model).toBeUndefined()
    expect(r.tts.params?.model).toBe('edge-tts')
  })

  it('空串 / 非字符串 asrModel、ttsModel 视为未配置，不注入', () => {
    const voice = normalizeVoiceConfig({
      provider: 'builtin',
      asrModel: '   ',
      ttsModel: 123,
    })
    const r = resolveCapabilityConfig(voice, CONFIG)
    expect(r.asr.params?.model).toBeUndefined()
    expect(r.tts.params?.model).toBeUndefined()
  })

  it('builtin 源同样把两个模型注入对应能力', () => {
    const voice = normalizeVoiceConfig({
      provider: 'builtin',
      asrModel: 'sensevoice-small',
      ttsModel: 'edge-tts',
    })
    const r = resolveCapabilityConfig(voice, CONFIG)
    expect(r.asr.params?.model).toBe('sensevoice-small')
    expect(r.tts.params?.model).toBe('edge-tts')
  })
})

describe('DashScopeWsAsr：误入的 TTS 模型不得让识别挂掉', () => {
  it('cosyvoice-v3-flash 被忽略，回退 paraformer-realtime-v2，且 voice 不进 parameters', () => {
    const asr = new DashScopeWsAsr(
      'https://dashscope.aliyuncs.com',
      { model: 'cosyvoice-v3-flash', voice: 'longyumi_v3' },
      'test-key',
    )
    const internal = asr as unknown as { model: string; parameters: Record<string, unknown> }
    expect(internal.model).toBe('paraformer-realtime-v2')
    expect(internal.parameters.voice).toBeUndefined()
    expect(internal.parameters.format).toBe('pcm')
    expect(internal.parameters.sample_rate).toBe(16000)
  })

  it('合法 ASR 模型不被误伤', () => {
    const asr = new DashScopeWsAsr(
      'https://dashscope.aliyuncs.com',
      { model: 'fun-asr-realtime' },
      'test-key',
    )
    expect((asr as unknown as { model: string }).model).toBe('fun-asr-realtime')
  })
})
