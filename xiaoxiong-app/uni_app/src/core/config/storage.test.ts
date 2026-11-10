import { describe, expect, it } from 'vitest'
import {
  createDefaultConfig,
  createDefaultVoice,
  normalizeConfig,
} from './storage'

describe('app config', () => {
  it('默认是自带服务、中文，语音服务为内置 / 本地 9529 / 无密钥', () => {
    const config = createDefaultConfig()
    expect(config.mode).toBe('byok')
    expect(config.language).toBe('zh-CN')
    expect(config.voice.provider).toBe('builtin')
    expect(config.voice.url).toBe('http://127.0.0.1:9529')
    expect(config.voice.apiKey).toBe('')
  })

  it('createDefaultVoice 返回可独立修改的副本', () => {
    const a = createDefaultVoice()
    const b = createDefaultVoice()
    a.url = 'http://x'
    expect(b.url).toBe('http://127.0.0.1:9529')
  })

  it('未知 provider 回退到内置，url / apiKey 收敛为字符串', () => {
    const config = normalizeConfig({
      voice: { provider: 'not-exist', url: '  http://x  ', apiKey: '123' },
    })
    expect(config.voice.provider).toBe('builtin')
    expect(config.voice.url).toBe('http://x')
    expect(config.voice.apiKey).toBe('123')
  })

  it('非字符串 apiKey 收敛为空串', () => {
    const config = normalizeConfig({
      voice: { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: 123 },
    })
    expect(config.voice.apiKey).toBe('')
  })

  it('内置缺地址时补默认根地址，避免空串连到奇怪的地方', () => {
    const config = normalizeConfig({ voice: { provider: 'builtin', url: '', apiKey: '' } })
    expect(config.voice.url).toBe('http://127.0.0.1:9529')
  })

  it('dashscope 缺地址时不补内置地址', () => {
    const config = normalizeConfig({ voice: { provider: 'dashscope', url: '', apiKey: 'sk-xxx' } })
    expect(config.voice.url).toBe('')
    expect(config.voice.apiKey).toBe('sk-xxx')
  })

  it('完全非法的输入也能得到可用默认配置', () => {
    const config = normalizeConfig('oops')
    expect(config.language).toBe('zh-CN')
    expect(config.voice.provider).toBe('builtin')
    expect(config.mode).toBe('byok')
  })

  it('平台托管模式可以被保存与还原', () => {
    expect(normalizeConfig({ mode: 'platform' }).mode).toBe('platform')
  })

  it('旧的 asr / llm / tts 字段被忽略（脏存档不复活能力子配置）', () => {
    const config = normalizeConfig({
      asr: { provider: 'funasr' },
      llm: { provider: 'ollama' },
      tts: { provider: 'kokoro' },
      voice: { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: '' },
    })
    expect('asr' in config).toBe(false)
    expect('llm' in config).toBe(false)
    expect('tts' in config).toBe(false)
    expect(config.voice.provider).toBe('builtin')
  })

  it('空输入继承 base 的语音配置', () => {
    const base = createDefaultConfig()
    base.voice.url = 'http://base'
    const config = normalizeConfig({}, base)
    expect(config.voice.url).toBe('http://base')
  })
})
