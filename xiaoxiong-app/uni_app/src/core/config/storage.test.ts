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
    expect(config.voice.builtin.url).toBe('http://127.0.0.1:9529')
    expect(config.voice.builtin.apiKey).toBe('')
  })

  it('createDefaultVoice 返回可独立修改的副本', () => {
    const a = createDefaultVoice()
    const b = createDefaultVoice()
    a.builtin.url = 'http://x'
    expect(b.builtin.url).toBe('http://127.0.0.1:9529')
  })

  it('两个来源的地址 / 密钥各自独立保存', () => {
    const a = createDefaultVoice()
    a.builtin.url = 'http://lan'
    a.dashscope.apiKey = 'sk-x'
    expect(a.builtin.url).toBe('http://lan')
    expect(a.dashscope.apiKey).toBe('sk-x')
    expect(a.builtin.apiKey).toBe('')
  })

  it('未知 provider 回退到内置，url / apiKey 收敛为字符串（迁移进内置这一份）', () => {
    const config = normalizeConfig({
      voice: { provider: 'not-exist', url: '  http://x  ', apiKey: '123' },
    })
    expect(config.voice.provider).toBe('builtin')
    expect(config.voice.builtin.url).toBe('http://x')
    expect(config.voice.builtin.apiKey).toBe('123')
  })

  it('非字符串 apiKey 收敛为空串', () => {
    const config = normalizeConfig({
      voice: { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: 123 },
    })
    expect(config.voice.builtin.apiKey).toBe('')
  })

  it('内置缺地址时补默认根地址，避免空串连到奇怪的地方', () => {
    const config = normalizeConfig({ voice: { provider: 'builtin', url: '', apiKey: '' } })
    expect(config.voice.builtin.url).toBe('http://127.0.0.1:9529')
  })

  it('dashscope 缺地址时不补内置地址', () => {
    const config = normalizeConfig({ voice: { provider: 'dashscope', url: '', apiKey: 'sk-xxx' } })
    expect(config.voice.dashscope.url).toBe('')
    expect(config.voice.dashscope.apiKey).toBe('sk-xxx')
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
    base.voice.builtin.url = 'http://base'
    const config = normalizeConfig({}, base)
    expect(config.voice.builtin.url).toBe('http://base')
  })

  it('默认播放源为百度，缺失时补默认', () => {
    expect(createDefaultConfig().playback.source).toBe('baidu')
    const config = normalizeConfig({})
    expect(config.playback.source).toBe('baidu')
  })

  it('非法的播放源回退到百度', () => {
    const config = normalizeConfig({ playback: { source: 'spotify' } })
    expect(config.playback.source).toBe('baidu')
  })

  it('合法的播放源被原样保留', () => {
    const config = normalizeConfig({ playback: { source: 'baidu' } })
    expect(config.playback.source).toBe('baidu')
  })

  it('默认开启悬浮，位置顶部居中，当前字幕 18px / 白色', () => {
    const p = createDefaultConfig().playback
    expect(p.floatPlayer).toBe(true)
    expect(p.floatPosition).toBe('top-center')
    expect(p.subtitleFontSize).toBe(18)
    expect(p.subtitleColor).toBe('#ffffff')
  })

  it('脏存档里悬浮/位置/字号/颜色收敛到合法默认值', () => {
    const config = normalizeConfig({
      playback: {
        floatPlayer: 'yes',
        floatPosition: 'nowhere',
        subtitleFontSize: 999,
        subtitleColor: 'red',
      },
    })
    expect(config.playback.floatPlayer).toBe(true)
    expect(config.playback.floatPosition).toBe('top-center')
    expect(config.playback.subtitleFontSize).toBe(18)
    expect(config.playback.subtitleColor).toBe('#ffffff')
  })

  it('合法的字号档位与颜色预设被原样保留', () => {
    const config = normalizeConfig({
      playback: { subtitleFontSize: 26, subtitleColor: '#5cd6b2' },
    })
    expect(config.playback.subtitleFontSize).toBe(26)
    expect(config.playback.subtitleColor).toBe('#5cd6b2')
  })
})
