import { z } from 'zod'
import type { Lang, LocationInfo } from '../../protocol'
import type { LocationProvider, RequestLocation } from './currentLocationTool'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const WEATHER_TOOL_NAME = 'get_weather'

/** WMO 天气代码 → 各语言描述（覆盖常见现象）。 */
const WEATHER_CODE: Record<string, { zh: string; en: string }> = {
  '0': { zh: '晴', en: 'Clear' },
  '1': { zh: '大致晴朗', en: 'Mainly clear' },
  '2': { zh: '局部多云', en: 'Partly cloudy' },
  '3': { zh: '阴', en: 'Overcast' },
  '45': { zh: '雾', en: 'Fog' },
  '48': { zh: '雾凇', en: 'Rime fog' },
  '51': { zh: '小毛毛雨', en: 'Light drizzle' },
  '53': { zh: '毛毛雨', en: 'Drizzle' },
  '55': { zh: '强毛毛雨', en: 'Dense drizzle' },
  '61': { zh: '小雨', en: 'Slight rain' },
  '63': { zh: '中雨', en: 'Rain' },
  '65': { zh: '大雨', en: 'Heavy rain' },
  '71': { zh: '小雪', en: 'Slight snow' },
  '73': { zh: '中雪', en: 'Snow' },
  '75': { zh: '大雪', en: 'Heavy snow' },
  '80': { zh: '阵雨', en: 'Rain showers' },
  '81': { zh: '强阵雨', en: 'Heavy showers' },
  '95': { zh: '雷阵雨', en: 'Thunderstorm' },
  '96': { zh: '雷阵雨伴冰雹', en: 'Thunderstorm w/ hail' },
}

function codeText(code: number | undefined, lang: Lang | string): string {
  const key = String(code ?? '')
  const hit = WEATHER_CODE[key]
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  if (!hit) return prefix === 'en' ? 'Unknown' : '未知'
  if (prefix === 'en') return hit.en
  return hit.zh
}

/** Open-Meteo 返回的当前+逐日数据结构（按需取字段，其余忽略）。 */
export interface WeatherPayload {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    weather_code?: number
    wind_speed_10m?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: number[]
  }
}

/** 把 Open-Meteo 返回格式化成可读天气文案（纯函数，便于测试）。 */
export function formatWeather(
  lang: Lang | string,
  loc: LocationInfo,
  payload: WeatherPayload
): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const where = loc.address ? `在${loc.address}` : `纬度${loc.latitude.toFixed(2)}、经度${loc.longitude.toFixed(2)}`
  const cur = payload.current
  const lines: string[] = []
  if (!cur) {
    return prefix === 'en'
      ? `No current weather data for ${where}.`
      : `${where}暂无当前天气数据。`
  }
  const temp = cur.temperature_2m != null ? `${Math.round(cur.temperature_2m)}°` : ''
  const feels = cur.apparent_temperature != null ? `${Math.round(cur.apparent_temperature)}°` : ''
  const cond = codeText(cur.weather_code, lang)
  if (prefix === 'en') {
    lines.push(`Current weather ${where}: ${cond}, ${temp} (feels like ${feels}).`)
  } else {
    lines.push(`当前${where}：${cond}，气温${temp}（体感${feels}）。`)
  }
  if (cur.relative_humidity_2m != null) {
    const h = `${cur.relative_humidity_2m}%`
    lines.push(prefix === 'en' ? `Humidity ${h}.` : `湿度${h}。`)
  }
  if (cur.wind_speed_10m != null) {
    const w = `${Math.round(cur.wind_speed_10m)}`
    lines.push(
      prefix === 'en'
        ? `Wind ${w} m/s.`
        : `风速${w} m/s。`
    )
  }
  const daily = payload.daily
  if (daily?.time && daily.temperature_2m_max) {
    const days = Math.min(3, daily.time.length)
    const parts: string[] = []
    for (let i = 0; i < days; i += 1) {
      const date = daily.time[i]?.slice(5) ?? ''
      const hi = daily.temperature_2m_max[i] != null ? `${Math.round(daily.temperature_2m_max[i])}°` : ''
      const lo = daily.temperature_2m_min?.[i] != null ? `${Math.round(daily.temperature_2m_min[i])}°` : ''
      const c = codeText(daily.weather_code?.[i], lang)
      const pop = daily.precipitation_probability_max?.[i]
      const popText = pop != null ? (prefix === 'en' ? `, ${pop}% rain` : `，降水${pop}%`) : ''
      parts.push(`${date} ${c} ${hi}/${lo}${popText}`)
    }
    const head = prefix === 'en' ? 'Next days: ' : '未来几天：'
    lines.push(head + parts.join('；'))
  }
  return lines.join('')
}

/** 默认用全局 fetch；测试可注入桩，避免真实联网。 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/**
 * 创建「获取当前位置天气」工具；无需入参，经纬度来自客户端上报的位置。
 * 返回 AgentScope 的 Tool 描述（name / description / inputSchema / call）。
 */
export function createWeatherTool(
  lang: Lang | string,
  locationProvider: LocationProvider,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  requestLocation?: RequestLocation
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const descriptions: Record<string, string> = {
    zh: '获取设备当前位置的天气（当前温度、体感、湿度、风速，及未来三天预报与降水概率）。当用户问“天气”“下雨吗”“今天多少度”等天气相关问题时调用此工具，不要凭记忆回答。',
    en: "Get the weather at the device's current location (current temperature, feels-like, humidity, wind, and the next 3 days with precipitation chance). Call when the user asks about the weather; do not answer from memory.",
  }
  return {
    name: WEATHER_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({}),
    call: async (): Promise<string> => {
      let loc = locationProvider()
      // 会话尚无位置：先向客户端要一次，再读最新位置
      if ((!loc || typeof loc.latitude !== 'number') && requestLocation) {
        loc = await requestLocation()
      }
      if (!loc || typeof loc.latitude !== 'number') {
        return prefix === 'en'
          ? 'Current location is unavailable, so I cannot fetch the weather.'
          : '当前位置未获取到，无法查询天气。'
      }
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=auto&forecast_days=3&wind_speed_unit=ms`
      try {
        const res = await fetcher(url)
        if (!res.ok) {
          return prefix === 'en'
            ? 'Weather service returned an error.'
            : '天气服务返回异常。'
        }
        const data = (await res.json()) as WeatherPayload
        return formatWeather(lang, loc, data)
      } catch {
        return prefix === 'en'
          ? 'Could not reach the weather service.'
          : '无法连接天气服务。'
      }
    },
  }
}
