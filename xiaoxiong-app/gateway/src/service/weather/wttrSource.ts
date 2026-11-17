import type { WeatherFetcher, WeatherPayload, WeatherSource } from './types'

/**
 * 默认天气源：wttr.in。
 *
 * 选它的理由（都是实测结论，不是猜测）：
 *  - 免费、无需任何 api-key（用户明确要求不使用 api-key、不依赖高德）。
 *  - 国内网络可达：实测 api.open-meteo.com 的 DNS 在国内被污染到 51.81.167.44，
 *    网关（设备内）和宿主机都连不上；wttr.in 两端 HTTP 200。
 *  - 数据完整：当前温度/体感/湿度/风速/天气代码 + 未来 3 天高低温/天气/降水概率。
 *  - 直接吃经纬度（/{lat},{lng}?format=j1），与前端 wgs84 系统定位天然匹配。
 *
 * wttr.in 用 Weather.com 的三位天气码、风速单位 km/h；这里在 source 层统一换算成
 * WMO 码 + m/s，交给下游 formatWeather（只认统一结构），换源不用动格式化。
 */

/** Weather.com 天气码 → WMO 码（覆盖 wttr.in 常见返回，未命中回退到 3「阴」）。 */
const WMO: Record<number, number> = {
  113: 0, // Sunny
  116: 2, // Partly cloudy
  119: 3, // Cloudy
  122: 3, // Overcast
  143: 45, // Mist
  176: 61, // Patchy rain nearby
  179: 71, // Patchy snow nearby
  182: 57, // Patchy sleet nearby
  185: 56, // Patchy freezing drizzle
  200: 95, // Thunderstorms
  201: 96, // Thunderstorm with hail
  227: 73, // Blowing snow
  230: 75, // Blizzard
  248: 45, // Fog
  260: 48, // Freezing fog
  263: 51, // Patchy light drizzle
  266: 53, // Light drizzle
  281: 56, // Freezing drizzle
  284: 57, // Heavy freezing drizzle
  293: 61, // Patchy light rain
  296: 61, // Light rain
  299: 63, // Moderate rain at times
  302: 63, // Moderate rain
  305: 65, // Heavy rain at times
  308: 65, // Heavy rain
  311: 56, // Light freezing rain
  314: 57, // Moderate/heavy freezing rain
  317: 56, // Light sleet
  320: 57, // Moderate/heavy sleet
  323: 71, // Patchy light snow
  326: 71, // Light snow
  329: 73, // Patchy moderate snow
  332: 73, // Moderate snow
  335: 75, // Patchy heavy snow
  338: 75, // Heavy snow
  350: 77, // Ice pellets
  353: 80, // Light rain shower
  356: 81, // Moderate/heavy rain shower
  359: 82, // Torrential rain shower
  362: 56, // Light sleet showers
  365: 57, // Moderate/heavy sleet showers
  368: 71, // Light snow showers
  371: 75, // Moderate/heavy snow showers
  374: 77, // Light showers of ice pellets
  377: 77, // Moderate/heavy showers of ice pellets
  386: 95, // Patchy light rain with thunder
  389: 95, // Moderate/heavy rain with thunder
  392: 95, // Patchy light snow with thunder
  395: 95, // Moderate/heavy snow with thunder
}

function toWmo(code: unknown): number {
  const n = typeof code === 'number' ? code : Number(code)
  return Number.isFinite(n) ? (WMO[n] ?? 3) : 3
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** wttr.in 的原始 JSON（只取用到的字段，其余忽略）。 */
interface WttrJson {
  current_condition?: Array<{
    temp_C?: string
    FeelsLikeC?: string
    humidity?: string
    weatherCode?: string
    windspeedKmph?: string
  }>
  weather?: Array<{
    date?: string
    maxtempC?: string
    mintempC?: string
    hourly?: Array<{ weatherCode?: string; chanceofrain?: string }>
  }>
}

/** 解析 wttr 原始响应为统一结构（导出纯函数便于测试，不联网）。 */
export function parseWttrWeather(raw: unknown): WeatherPayload | null {
  const data = raw as WttrJson
  const cur = data?.current_condition?.[0]
  if (!cur) return null
  const temp = num(cur.temp_C)
  if (temp == null) return null

  const current: NonNullable<WeatherPayload['current']> = {
    temperature_2m: temp,
    weather_code: toWmo(cur.weatherCode),
  }
  const feels = num(cur.FeelsLikeC)
  const hum = num(cur.humidity)
  const windKmh = num(cur.windspeedKmph)
  if (feels != null) current.apparent_temperature = feels
  if (hum != null) current.relative_humidity_2m = hum
  if (windKmh != null) current.wind_speed_10m = Math.round((windKmh / 3.6) * 10) / 10

  const payload: WeatherPayload = { current }
  const days = data.weather ?? []
  if (days.length) {
    payload.daily = {
      time: days.map((d) => d.date ?? ''),
      weather_code: days.map((d) => toWmo(d.hourly?.[Math.floor((d.hourly?.length ?? 1) / 2)]?.weatherCode)),
      temperature_2m_max: days.map((d) => num(d.maxtempC) ?? 0),
      temperature_2m_min: days.map((d) => num(d.mintempC) ?? 0),
      precipitation_probability_max: days.map((d) =>
        Math.max(0, ...(d.hourly ?? []).map((h) => num(h.chanceofrain) ?? 0))
      ),
    }
  }
  return payload
}

export function createWttrSource(): WeatherSource {
  return {
    name: 'wttr.in',
    async fetch(lat, lng, fetcher: WeatherFetcher): Promise<WeatherPayload | null> {
      const url = `https://wttr.in/${lat.toFixed(4)},${lng.toFixed(4)}?format=j1`
      const res = await fetcher(url)
      if (!res.ok) return null
      return parseWttrWeather(await res.json())
    },
  }
}
