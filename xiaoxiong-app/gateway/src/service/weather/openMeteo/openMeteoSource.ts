import type { WeatherFetcher, WeatherPayload, WeatherSource } from '../types'

/**
 * 备选天气源：Open-Meteo（免费、无需 key、数据即 WMO 码 + m/s，无需换算）。
 *
 * 作为可换源架构的第二个实现保留：海外或 DNS 正常的环境可用它。
 * 国内实测 api.open-meteo.com 被 DNS 污染（解析到 51.81.167.44）而连不上，
 * 故默认源改为 wttr.in（见 wttrSource.ts）；需要切换时只需在组合根注入本源。
 */
export function createOpenMeteoSource(): WeatherSource {
  return {
    name: 'open-meteo',
    async fetch(lat, lng, fetcher: WeatherFetcher): Promise<WeatherPayload | null> {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=auto&forecast_days=3&wind_speed_unit=ms`
      const res = await fetcher(url)
      if (!res.ok) return null
      return (await res.json()) as WeatherPayload
    },
  }
}
