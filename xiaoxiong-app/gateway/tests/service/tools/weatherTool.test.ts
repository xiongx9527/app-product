import { describe, it, expect, vi } from 'vitest'
import { createWeatherTool, formatWeather, WEATHER_TOOL_NAME, type WeatherPayload } from '../../../src/service/tools/weatherTool'
import { createToolkit } from '../../../src/service/tools/index'
import type { WeatherSource } from '../../../src/service/weather'

const SAMPLE: WeatherPayload = {
  current: {
    temperature_2m: 21.4,
    apparent_temperature: 22.0,
    relative_humidity_2m: 60,
    weather_code: 1,
    wind_speed_10m: 3.1,
  },
  daily: {
    time: ['2026-11-07', '2026-11-08', '2026-11-09'],
    weather_code: [1, 61, 3],
    temperature_2m_max: [23, 19, 20],
    temperature_2m_min: [14, 12, 13],
    precipitation_probability_max: [10, 80, 40],
  },
}

/** 测试用天气源桩：直接吐统一结构，不联网。可记录 fetch 调用验证注入生效。 */
function stubSource(payload: WeatherPayload | null = SAMPLE): WeatherSource & { fetch: ReturnType<typeof vi.fn> } {
  return {
    name: 'stub',
    fetch: vi.fn(async () => payload),
  }
}

describe('weatherTool', () => {
  it('工具名固定、描述随语言本地化', () => {
    const t = createWeatherTool('zh-CN', () => null)
    expect(t.name).toBe(WEATHER_TOOL_NAME)
    expect(t.description).toContain('天气')
    expect(createWeatherTool('en-US', () => null).description.toLowerCase()).toContain('weather')
  })

  it('formatWeather 按语言组织当前+未来天气（中文口语化）', () => {
    const zh = formatWeather('zh-CN', { latitude: 31.23, longitude: 121.47, address: '上海市' }, SAMPLE)
    expect(zh).toContain('上海')
    expect(zh).toContain('21度')          // 气温说「度」不说「°」
    expect(zh).toContain('湿度60%')
    expect(zh).toContain('有点风')         // 风速 m/s → 口语风力
    expect(zh).not.toContain('m/s')
    expect(zh).toContain('接下来几天')
    expect(zh).toContain('今天')          // 日期说「今天/明天/后天」
    expect(zh).toContain('明天')
    expect(zh).toContain('后天')
    expect(zh).toContain('很可能下雨')     // 降水概率 → 口语
    expect(zh).not.toContain('11-08')
    expect(zh).toContain('温馨提示')       // 天气提示
    expect(zh).toContain('适合出门')       // 晴天提示「适合什么」
  })

  it('温馨提示按天气给不同建议（注意什么/适合什么）', () => {
    const base = { latitude: 31.23, longitude: 121.47, address: '上海市' }
    const rain = formatWeather('zh-CN', base, {
      ...SAMPLE,
      current: { ...SAMPLE.current!, weather_code: 63 }, // 中雨
    })
    expect(rain).toContain('带伞')
    const storm = formatWeather('zh-CN', base, {
      ...SAMPLE,
      current: { ...SAMPLE.current!, weather_code: 95 }, // 雷阵雨
    })
    expect(storm).toContain('待室内')
  })

  it('体感温度与实际差 ≤2 度时不提体感，>2 度才提', () => {
    const base = { latitude: 31.23, longitude: 121.47, address: '上海市' }
    const close = formatWeather('zh-CN', base, {
      ...SAMPLE,
      current: { ...SAMPLE.current!, temperature_2m: 21, apparent_temperature: 22 },
    })
    expect(close).not.toContain('体感')
    const far = formatWeather('zh-CN', base, {
      ...SAMPLE,
      current: { ...SAMPLE.current!, temperature_2m: 21, apparent_temperature: 26 },
    })
    expect(far).toContain('体感26度')
  })

  it('位置缺失时给出提示而非联网', async () => {
    const t = createWeatherTool('zh-CN', () => null)
    expect(await t.call?.()).toContain('未获取')
  })

  it('call 用注入的数据源取数并格式化', async () => {
    const source = stubSource()
    const t = createWeatherTool('zh-CN', () => ({ latitude: 31.23, longitude: 121.47 }), source)
    const out = await t.call?.()
    expect(out).toContain('21度')
    expect(source.fetch).toHaveBeenCalledWith(31.23, 121.47, expect.any(Function))
  })

  it('可换源：注入不同 WeatherSource 即走不同数据源，工具逻辑不变', async () => {
    const source = stubSource({ current: { temperature_2m: 5, weather_code: 71 } })
    const t = createWeatherTool('zh-CN', () => ({ latitude: 1, longitude: 2 }), source)
    expect(await t.call?.()).toContain('5度')
    expect(source.name).toBe('stub')
  })

  it('数据源返回空时给出「天气服务返回异常」而非抛错', async () => {
    const t = createWeatherTool('zh-CN', () => ({ latitude: 1, longitude: 2 }), stubSource(null))
    expect(await t.call?.()).toContain('异常')
  })

  it('数据源抛错时给出「无法连接天气服务」兜底', async () => {
    const source: WeatherSource = {
      name: 'boom',
      fetch: async () => { throw new Error('network down') },
    }
    const t = createWeatherTool('zh-CN', () => ({ latitude: 1, longitude: 2 }), source)
    expect(await t.call?.()).toContain('无法连接天气服务')
  })

  it('createToolkit 登记了天气工具', () => {
    const schemas = createToolkit('zh-CN', 'Asia/Shanghai', () => null).getJSONSchemas()
    expect(schemas.some((s: { function: { name: string } }) => s.function.name === WEATHER_TOOL_NAME)).toBe(true)
  })

  it('懒加载：provider 暂无位置但有 requestLocation 时，等待上报后再联网取天气', async () => {
    let loc: { latitude: number; longitude: number; address?: string } | null = null
    const provider = () => loc
    const requestLocation = async () => {
      loc = { latitude: 31.23, longitude: 121.47, address: '上海市' }
      return loc
    }
    const t = createWeatherTool('zh-CN', provider, stubSource(), requestLocation)
    const out = await t.call?.()
    expect(out).toContain('上海')
    expect(out).toContain('21度')
  })

  it('懒加载：requestLocation 仍拿不到位置时给出提示而非联网', async () => {
    const provider = () => null
    const requestLocation = async () => null
    const t = createWeatherTool('zh-CN', provider, stubSource(), requestLocation)
    expect(await t.call?.()).toContain('未获取')
  })
})
