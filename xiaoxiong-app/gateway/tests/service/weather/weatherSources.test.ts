import { describe, it, expect, vi } from 'vitest'
import {
  parseWttrWeather,
  createWttrSource,
  createOpenMeteoSource,
  createDefaultWeatherSource,
  type WeatherFetcher,
} from '../../../src/service/weather/index'

/** wttr.in 的真实响应切片（2026-11-17 实测，经纬度 28.67,116.01）。 */
const WTTR_SAMPLE = {
  current_condition: [{
    temp_C: '15',
    FeelsLikeC: '14',
    humidity: '92',
    weatherCode: '176',
    windspeedKmph: '15',
  }],
  weather: [
    {
      date: '2026-11-17', maxtempC: '17', mintempC: '14',
      hourly: [{ weatherCode: '176', chanceofrain: '40' }, { weatherCode: '176', chanceofrain: '64' }],
    },
    {
      date: '2026-11-18', maxtempC: '15', mintempC: '10',
      hourly: [{ weatherCode: '176', chanceofrain: '30' }],
    },
  ],
}

describe('wttr 天气源', () => {
  it('解析当前天气：温度/体感/湿度 + Weather.com 码换算 WMO + km/h 换 m/s', () => {
    const p = parseWttrWeather(WTTR_SAMPLE)!
    expect(p.current?.temperature_2m).toBe(15)
    expect(p.current?.apparent_temperature).toBe(14)
    expect(p.current?.relative_humidity_2m).toBe(92)
    expect(p.current?.weather_code).toBe(61) // 176 = patchy rain → WMO 61 小雨
    expect(p.current?.wind_speed_10m).toBeCloseTo(4.2, 1) // 15 km/h ≈ 4.2 m/s
  })

  it('解析未来天气：高低温/天气码/最大降水概率', () => {
    const p = parseWttrWeather(WTTR_SAMPLE)!
    expect(p.daily?.time).toEqual(['2026-11-17', '2026-11-18'])
    expect(p.daily?.temperature_2m_max).toEqual([17, 15])
    expect(p.daily?.temperature_2m_min).toEqual([14, 10])
    expect(p.daily?.precipitation_probability_max).toEqual([64, 30])
  })

  it('未知天气码回退到「阴」而非报错', () => {
    const p = parseWttrWeather({ current_condition: [{ temp_C: '20', weatherCode: '999' }] })!
    expect(p.current?.weather_code).toBe(3)
  })

  it('空响应返回 null', () => {
    expect(parseWttrWeather({})).toBeNull()
    expect(parseWttrWeather(null)).toBeNull()
  })

  it('fetch 用经纬度拼 URL，并把原始 JSON 交给解析器', async () => {
    const fetcher: WeatherFetcher = vi.fn(async () => ({ ok: true, json: async () => WTTR_SAMPLE }))
    const src = createWttrSource()
    const p = await src.fetch(28.6762, 116.0155, fetcher)
    expect(p?.current?.temperature_2m).toBe(15)
    expect(fetcher).toHaveBeenCalledWith('https://wttr.in/28.6762,116.0155?format=j1')
  })

  it('HTTP 失败返回 null', async () => {
    const src = createWttrSource()
    expect(await src.fetch(1, 2, async () => ({ ok: false, json: async () => ({}) }))).toBeNull()
  })

  it('fetchCity 按城市名拼 URL（不写死源、免 geocoding）', async () => {
    const fetcher: WeatherFetcher = vi.fn(async () => ({ ok: true, json: async () => WTTR_SAMPLE }))
    const src = createWttrSource()
    const p = await src.fetchCity!('北京', fetcher)
    expect(p?.current?.temperature_2m).toBe(15)
    const url = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('wttr.in')
    expect(url).toContain(encodeURIComponent('北京'))
    expect(url).not.toMatch(/\d+\.\d+,\d+\.\d+/) // 不是经纬度形式
  })
})

describe('open-meteo 备选源', () => {
  it('fetch 用经纬度拼 URL，数据原样返回（本身已是统一结构）', async () => {
    const payload = { current: { temperature_2m: 26, weather_code: 0 } }
    const fetcher: WeatherFetcher = vi.fn(async () => ({ ok: true, json: async () => payload }))
    const src = createOpenMeteoSource()
    const p = await src.fetch(31.23, 121.47, fetcher)
    expect(p?.current?.temperature_2m).toBe(26)
    const url = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('latitude=31.23')
    expect(url).toContain('longitude=121.47')
    expect(url).toContain('wind_speed_unit=ms')
  })
})

describe('默认天气源', () => {
  it('默认工厂产出 wttr.in（免 api-key、国内可达）', () => {
    expect(createDefaultWeatherSource().name).toBe('wttr.in')
  })
})
