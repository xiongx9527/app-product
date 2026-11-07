import { describe, expect, it } from 'vitest'
import { PROVIDERS } from './providers'
import {
  coerceFieldValue,
  createDefaultCapability,
  createDefaultConfig,
  normalizeConfig,
} from './storage'

describe('app config', () => {
  it('默认是自带服务、中文，并为每个厂商预置默认参数', () => {
    const config = createDefaultConfig()
    expect(config.mode).toBe('byok')
    expect(config.language).toBe('zh-CN')
    expect(Object.keys(config.asr.byProvider)).toEqual(
      PROVIDERS.asr.map((item) => item.id)
    )
    expect(config.asr.byProvider[config.asr.provider].baseUrl).toBe(
      'http://127.0.0.1:9529/v1'
    )
  })

  it('未知厂商回退到第一个，未知字段被丢弃', () => {
    const config = normalizeConfig({
      asr: {
        provider: 'not-exist',
        byProvider: { 'openai-compatible': { baseUrl: 'http://x', junk: 1 } },
      },
    })
    expect(config.asr.provider).toBe('openai-compatible')
    expect(config.asr.byProvider['openai-compatible'].baseUrl).toBe('http://x')
    expect(config.asr.byProvider['openai-compatible'].junk).toBeUndefined()
  })

  it('数字与开关收敛到正确类型', () => {
    const config = normalizeConfig({
      llm: {
        provider: 'openai-compatible',
        byProvider: {
          'openai-compatible': { temperature: '0.3', stream: 'false' },
        },
      },
    })
    expect(config.llm.byProvider['openai-compatible'].temperature).toBe(0.3)
    expect(config.llm.byProvider['openai-compatible'].stream).toBe(false)
  })

  it('数字越界会被夹到字段范围内', () => {
    const field = {
      key: 'temperature',
      label: 'Temperature',
      type: 'number' as const,
      min: 0,
      max: 2,
    }
    expect(coerceFieldValue(field, 9, 0.7)).toBe(2)
    expect(coerceFieldValue(field, 'abc', 0.7)).toBe(0.7)
  })

  it('非法单选项回退默认值', () => {
    const field = {
      key: 'format',
      label: '格式',
      type: 'select' as const,
      options: [{ label: 'mp3', value: 'mp3' }],
    }
    expect(coerceFieldValue(field, 'exe', 'mp3')).toBe('mp3')
    expect(coerceFieldValue(field, 'mp3', 'wav')).toBe('mp3')
  })

  it('完全非法的输入也能得到可用默认配置', () => {
    const config = normalizeConfig('oops')
    expect(config.language).toBe('zh-CN')
    expect(config.tts.provider).toBe('openai-compatible')
    expect(config.mode).toBe('byok')
  })

  it('平台托管模式可以被保存与还原', () => {
    expect(normalizeConfig({ mode: 'platform' }).mode).toBe('platform')
  })

  it('恢复单一能力不会影响其他能力', () => {
    const config = createDefaultConfig()
    config.asr.provider = 'funasr'
    config.llm.provider = 'ollama'

    const fresh = createDefaultCapability('asr')
    expect(fresh.provider).toBe('openai-compatible')
    expect(config.llm.provider).toBe('ollama')
  })

  it('默认位置服务是天地图，未填 Key', () => {
    const config = createDefaultConfig()
    expect(config.geocode.provider).toBe('tianditu')
    expect(config.geocode.key).toBe('')
  })

  it('位置服务：非法服务商回退天地图，Key 收敛为字符串', () => {
    const config = normalizeConfig({ geocode: { provider: 'unknown', key: 12345 } })
    expect(config.geocode.provider).toBe('tianditu')
    expect(config.geocode.key).toBe('12345')
  })

  it('位置服务：合法的腾讯/高德/百度配置被保留', () => {
    expect(normalizeConfig({ geocode: { provider: 'tencent', key: 'TK' } }).geocode).toEqual({
      provider: 'tencent',
      key: 'TK',
    })
    expect(normalizeConfig({ geocode: { provider: 'amap', key: 'AK' } }).geocode).toEqual({
      provider: 'amap',
      key: 'AK',
    })
    expect(normalizeConfig({ geocode: { provider: 'baidu', key: 'BK' } }).geocode).toEqual({
      provider: 'baidu',
      key: 'BK',
    })
  })
})
