import { describe, expect, it } from 'vitest'
import {
  createDefaultConfig,
  createDefaultVoice,
  normalizeConfig,
} from '../../../src/core/config/storage'

describe('app config', () => {
  it('默认是自带服务、中文，语音服务为内置 / 公网代理 / 无密钥', () => {
    const config = createDefaultConfig()
    expect(config.mode).toBe('byok')
    expect(config.language).toBe('zh-CN')
    expect(config.voice.provider).toBe('builtin')
    expect(config.voice.builtin.url).toBe('https://25946kt718.goho.co')
    expect(config.voice.builtin.apiKey).toBe('')
  })

  it('createDefaultVoice 返回可独立修改的副本', () => {
    const a = createDefaultVoice()
    const b = createDefaultVoice()
    a.builtin.url = 'http://x'
    expect(b.builtin.url).toBe('https://25946kt718.goho.co')
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

  it('默认 ASR / TTS 模型字段为空串（留空=来源默认）', () => {
    const v = createDefaultVoice()
    expect(v.builtin.asrModel).toBe('')
    expect(v.builtin.ttsModel).toBe('')
  })

  it('ASR / TTS 模型名 trim，非字符串与缺省收敛为空串', () => {
    const config = normalizeConfig({
      voice: {
        provider: 'builtin',
        builtin: { url: '', apiKey: '', asrModel: '  sensevoice  ', ttsModel: 123 },
      },
    })
    expect(config.voice.builtin.asrModel).toBe('sensevoice')
    expect(config.voice.builtin.ttsModel).toBe('')
  })

  it('内置缺地址时补默认根地址，避免空串连到奇怪的地方', () => {
    const config = normalizeConfig({ voice: { provider: 'builtin', url: '', apiKey: '' } })
    expect(config.voice.builtin.url).toBe('https://25946kt718.goho.co')
  })

  it('存量旧默认地址（本机 9529）自动迁移到公网代理，用户自填地址不动', () => {
    const migrated = normalizeConfig({
      voice: { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: '' },
    })
    expect(migrated.voice.builtin.url).toBe('https://25946kt718.goho.co')
    const kept = normalizeConfig({
      voice: { provider: 'builtin', url: 'http://192.168.1.20:9529', apiKey: '' },
    })
    expect(kept.voice.builtin.url).toBe('http://192.168.1.20:9529')
  })

  it('旧 dashscope 来源存档落回内置：provider 收敛、dashscope 子配置丢弃、走内置默认地址', () => {
    const config = normalizeConfig({
      voice: {
        provider: 'dashscope',
        dashscope: { url: 'https://old-dashscope', apiKey: 'sk-old', model: 'qwen' },
      },
    })
    expect(config.voice.provider).toBe('builtin')
    expect(config.voice.builtin.url).toBe('https://25946kt718.goho.co')
    expect(config.voice.builtin.apiKey).toBe('')
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

  it('默认悬浮小圆（开启），位置顶部居中，当前字幕 18px / 白色', () => {
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

  it('默认 mcp 为空列表', () => {
    const config = createDefaultConfig()
    expect(config.mcp).toEqual({ enabled: true, servers: [] })
  })

  it('记忆合并阈值/频率收敛为非负整数，非法回退默认（30 / 5）', () => {
    const config = normalizeConfig({
      memory: { autoMemory: true, consolidateThreshold: -3, consolidateEvery: 'x' },
    })
    expect(config.memory.autoMemory).toBe(true)
    expect(config.memory.consolidateThreshold).toBe(30)
    expect(config.memory.consolidateEvery).toBe(5)
    const config2 = normalizeConfig({ memory: { consolidateThreshold: 0, consolidateEvery: 2 } })
    expect(config2.memory.consolidateThreshold).toBe(0)
    expect(config2.memory.consolidateEvery).toBe(2)
  })

  it('主题：仅 4 个深色主题合法；老配置 auto（已移除）回退 default', () => {
    expect(normalizeConfig({ general: { theme: 'auto' } }).general.theme).toBe('default')
    expect(normalizeConfig({ general: { theme: 'bogus' } }).general.theme).toBe('default')
    expect(normalizeConfig({ general: { theme: 'purple' } }).general.theme).toBe('purple')
    expect(normalizeConfig({ general: { theme: 'teal' } }).general.theme).toBe('teal')
    expect(normalizeConfig({ general: { theme: 'amber' } }).general.theme).toBe('amber')
  })

  it('normalizeMcp 保留合法项、丢弃缺 command 的 stdio 与缺 url 的 sse/http', () => {
    const config = normalizeConfig({
      mcp: {
        servers: [
          { id: '1', name: 'fs', enabled: true, transport: 'stdio', command: 'npx foo' },
          { id: '2', name: 'bad-stdio', enabled: true, transport: 'stdio' }, // 缺 command → 丢弃
          { id: '3', name: 'http-srv', enabled: false, transport: 'http', url: 'http://x/mcp' },
          { id: '4', name: 'bad-sse', enabled: true, transport: 'sse' }, // 缺 url → 丢弃
          { id: '5', name: 'weird', enabled: true, transport: 'telnet' }, // 非法传输 → 丢弃
        ],
      },
    })
    const names = config.mcp.servers.map((s) => s.name)
    expect(names).toContain('fs')
    expect(names).toContain('http-srv')
    expect(names).not.toContain('bad-stdio')
    expect(names).not.toContain('bad-sse')
    expect(names).not.toContain('weird')
    // enabled 收敛为 boolean（http-srv 为 false）
    const http = config.mcp.servers.find((s) => s.name === 'http-srv')
    expect(http?.enabled).toBe(false)
  })

  it('normalizeMcp 对缺失/非数组回落到空列表', () => {
    const config = normalizeConfig({ mcp: 'not-an-object' })
    expect(config.mcp).toEqual({ enabled: true, servers: [] })
  })
})
