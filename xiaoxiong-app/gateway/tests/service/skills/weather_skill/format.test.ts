import { describe, it, expect } from 'vitest'
import { formatWeather } from '../../../../src/service/skills/weather_skill/format'
import type { WeatherPayload } from '../../../../src/service/skills/weather_skill/weather/types'

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

const base = { latitude: 31.23, longitude: 121.47, address: '上海市' }

describe('weather skill：formatWeather 口语化文案', () => {
  it('按语言组织当前+未来天气（中文口语化）', () => {
    const zh = formatWeather('zh-CN', base, SAMPLE)
    expect(zh).toContain('上海')
    expect(zh).toContain('21度')
    expect(zh).toContain('湿度60%')
    expect(zh).toContain('有点风')
    expect(zh).not.toContain('m/s')
    expect(zh).toContain('接下来几天')
    expect(zh).toContain('今天')
    expect(zh).toContain('明天')
    expect(zh).toContain('后天')
    expect(zh).toContain('很可能下雨')
    expect(zh).not.toContain('11-08')
    expect(zh).toContain('温馨提示')
    expect(zh).toContain('适合出门')
  })

  it('温馨提示按天气给不同建议（注意什么/适合什么）', () => {
    const rain = formatWeather('zh-CN', base, { ...SAMPLE, current: { ...SAMPLE.current!, weather_code: 63 } })
    expect(rain).toContain('带伞')
    const storm = formatWeather('zh-CN', base, { ...SAMPLE, current: { ...SAMPLE.current!, weather_code: 95 } })
    expect(storm).toContain('待室内')
  })

  it('体感温度与实际差 ≤2 度时不提体感，>2 度才提', () => {
    const close = formatWeather('zh-CN', base, { ...SAMPLE, current: { ...SAMPLE.current!, temperature_2m: 21, apparent_temperature: 22 } })
    expect(close).not.toContain('体感')
    const far = formatWeather('zh-CN', base, { ...SAMPLE, current: { ...SAMPLE.current!, temperature_2m: 21, apparent_temperature: 26 } })
    expect(far).toContain('体感26度')
  })

  it('不显示经纬度：无地名时用「当地」，不报坐标', () => {
    const out = formatWeather('zh-CN', { latitude: 31.23, longitude: 121.47 }, SAMPLE)
    expect(out).toContain('当地')
    expect(out).not.toContain('31.23')
    expect(out).not.toContain('121.47')
  })
})
