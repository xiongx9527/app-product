import { describe, it, expect } from 'vitest'
import { createWeatherTool, formatWeather, WEATHER_TOOL_NAME, type WeatherPayload } from './weatherTool'
import { createToolkit } from './index'

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

describe('weatherTool', () => {
  it('工具名固定、描述随语言本地化', () => {
    const t = createWeatherTool('zh-CN', () => null)
    expect(t.name).toBe(WEATHER_TOOL_NAME)
    expect(t.description).toContain('天气')
    expect(createWeatherTool('en-US', () => null).description.toLowerCase()).toContain('weather')
  })

  it('formatWeather 按语言组织当前+未来天气', () => {
    const zh = formatWeather('zh-CN', { latitude: 31.23, longitude: 121.47, address: '上海市' }, SAMPLE)
    expect(zh).toContain('上海')
    expect(zh).toContain('21°')
    expect(zh).toContain('湿度60%')
    expect(zh).toContain('风速3 m/s')
    expect(zh).toContain('未来几天')
    expect(zh).toContain('11-08')
    expect(zh).toContain('降水80%')
  })

  it('位置缺失时给出提示而非联网', async () => {
    const t = createWeatherTool('zh-CN', () => null)
    expect(await t.call?.()).toContain('未获取')
  })

  it('call 用注入的 fetcher 取数并格式化', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => SAMPLE as unknown as Record<string, unknown>,
    })
    const t = createWeatherTool('zh-CN', () => ({ latitude: 31.23, longitude: 121.47 }), fetcher)
    const out = await t.call?.()
    expect(out).toContain('21°')
  })

  it('createToolkit 登记了天气工具', () => {
    const schemas = createToolkit('zh-CN', 'Asia/Shanghai', () => null).getJSONSchemas()
    expect(schemas.some((s: { function: { name: string } }) => s.function.name === WEATHER_TOOL_NAME)).toBe(true)
  })
})
