import { z } from 'zod'
import type { Lang, LocationInfo } from '../../protocol'
import type { LocationProvider, RequestLocation } from './currentLocationTool'
import {
  createDefaultWeatherSource,
  type WeatherFetcher,
  type WeatherSource,
  type WeatherPayload,
} from '../skills/weather_skill/weather'

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

/**
 * 天气温馨提示：不同天气注意什么、适合做什么（用户 2026-11-19 要求加）。
 * 按 WMO 代码分组，文案口语简短、TTS 友好；按当前天气给一条即可。
 */
const WEATHER_TIPS: Record<string, { zh: string; en: string }> = {
  // 晴好
  '0': { zh: '天气不错，适合出门走走，记得防晒。', en: 'Nice day, good for going out. Don’t forget sunscreen.' },
  '1': { zh: '天气不错，适合出门，晒晒太阳挺舒服。', en: 'Lovely day, great for a walk in the sun.' },
  '2': { zh: '天气还行，适合出门，注意防晒。', en: 'Decent day for going out; mind the sun.' },
  // 阴/雾
  '3': { zh: '天有点阴，出门挺合适，光线暗注意脚下。', en: 'Overcast but fine for going out; watch your step in the dim light.' },
  '45': { zh: '有雾，能见度低，开车慢点、注意保暖。', en: 'Foggy and low visibility; drive slowly and keep warm.' },
  '48': { zh: '有雾凇，天冷路滑，开车走路都慢点。', en: 'Rime fog, cold and slippery; take it slow.' },
  // 毛毛雨
  '51': { zh: '有点毛毛雨，出门带把伞，路面有点滑。', en: 'Light drizzle; bring an umbrella, roads are a bit slick.' },
  '53': { zh: '毛毛雨，出门记得带伞。', en: 'Drizzling; remember your umbrella.' },
  '55': { zh: '毛毛雨有点密，带伞、注意路滑。', en: 'Dense drizzle; umbrella and watch your step.' },
  // 雨
  '61': { zh: '下小雨，出门带伞，适合待室内。', en: 'Light rain; bring an umbrella, good day to stay in.' },
  '63': { zh: '下中雨，记得带伞，出门注意防滑。', en: 'Rain; umbrella and watch for slippery ground.' },
  '65': { zh: '雨挺大，尽量少出门，出门一定带伞、避开积水。', en: 'Heavy rain; better stay in, umbrella if you must go, avoid puddles.' },
  '80': { zh: '可能有阵雨，出门带把伞以防万一。', en: 'Possible showers; take an umbrella just in case.' },
  '81': { zh: '阵雨挺急，带伞、注意躲雨。', en: 'Heavy showers; umbrella and find shelter.' },
  // 雪
  '71': { zh: '下小雪，注意保暖，路面滑走路慢点，适合赏雪。', en: 'Light snow; bundle up, watch your step, nice for snow watching.' },
  '73': { zh: '下雪了，穿暖点、路滑慢行，挺适合玩雪。', en: 'Snowing; dress warm, walk carefully, fun for snow play.' },
  '75': { zh: '大雪，注意保暖防滑，尽量少出门，出门小心路滑。', en: 'Heavy snow; keep warm, avoid going out, careful on ice.' },
  // 雷暴/冰雹
  '95': { zh: '有雷阵雨，尽量待室内，别在大树和高处躲雨。', en: 'Thunderstorm; stay indoors, away from tall trees and high ground.' },
  '96': { zh: '有雷阵雨伴冰雹，快找地方躲躲，别在室外逗留。', en: 'Thunderstorm with hail; find shelter now, don’t stay outdoors.' },
}

function weatherTip(code: number | undefined, lang: Lang | string): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const hit = WEATHER_TIPS[String(code ?? '')]
  if (!hit) return ''
  return prefix === 'en' ? hit.en : hit.zh
}

/**
 * 统一天气结构 + 底层 fetcher 类型现在定义在 service/weather 域（可换源）。
 * 这里 re-export 保持旧调用方/测试的 import 路径不变。
 */
export type { WeatherPayload } from '../skills/weather_skill/weather'
/** 兼容旧名 Fetcher（= WeatherFetcher）。 */
export type Fetcher = WeatherFetcher

/** 风速(m/s) → 口语化风力（播报用，m/s 太专业听不懂）。 */
function windWords(ms: number): string {
  if (ms < 1) return '几乎没风'
  if (ms < 3) return '有点微风'
  if (ms < 5) return '有点风'
  if (ms < 8) return '风有点大'
  return '风挺大'
}

/** 降水概率 → 口语（30% 以下不提，避免噪声）。 */
function rainWords(pop: number | undefined): string {
  if (pop == null || pop < 30) return ''
  if (pop >= 70) return '，很可能下雨'
  if (pop >= 40) return '，可能会下雨'
  return '，有点可能下雨'
}

/** 第 i 天的口语日期：今天/明天/后天；更远用 M月D日。 */
function dayWords(i: number, isoDate: string | undefined): string {
  if (i === 0) return '今天'
  if (i === 1) return '明天'
  if (i === 2) return '后天'
  return isoDate?.slice(5).replace('-', '月') + '日' || '之后'
}

/** 把 Open-Meteo 返回格式化成可读天气文案（纯函数，便于测试）。
 *  中文播报口语化：温度说「度」、体感差小不提、风速说风力、降水说「可能下雨」、
 *  日期说「今天/明天/后天」——专业术语和数字编号 TTS 念出来难懂（用户反馈）。 */
export function formatWeather(
  lang: Lang | string,
  loc: LocationInfo,
  payload: WeatherPayload
): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  // 用户要求不显示经纬度：没有地名时用「当地」/「here」，不报坐标
  const where = loc.address
    ? loc.address
    : (prefix === 'en' ? 'here' : '当地')
  const cur = payload.current
  const lines: string[] = []
  if (!cur) {
    return prefix === 'en'
      ? `No current weather data for ${where}.`
      : `${where}暂时没有天气数据。`
  }
  const cond = codeText(cur.weather_code, lang)
  if (prefix === 'en') {
    const temp = cur.temperature_2m != null ? `${Math.round(cur.temperature_2m)}°` : ''
    const feels = cur.apparent_temperature != null ? `${Math.round(cur.apparent_temperature)}°` : ''
    lines.push(`Current weather ${where}: ${cond}, ${temp} (feels like ${feels}).`)
    if (cur.relative_humidity_2m != null) lines.push(`Humidity ${cur.relative_humidity_2m}%.`)
    if (cur.wind_speed_10m != null) lines.push(`Wind ${Math.round(cur.wind_speed_10m)} m/s.`)
  } else {
    // 当前：{地点}，{天气}，气温X度；体感差>2度才提；湿度；风力（用户要求去掉「在」字）
    const temp = cur.temperature_2m != null ? `${Math.round(cur.temperature_2m)}度` : ''
    let curLine = `${where}，${cond}，气温${temp}`
    if (cur.apparent_temperature != null && cur.temperature_2m != null
        && Math.abs(cur.apparent_temperature - cur.temperature_2m) > 2) {
      curLine += `，体感${Math.round(cur.apparent_temperature)}度`
    }
    curLine += '。'
    if (cur.relative_humidity_2m != null) curLine += `湿度${cur.relative_humidity_2m}%。`
    if (cur.wind_speed_10m != null) curLine += `${windWords(cur.wind_speed_10m)}。`
    lines.push(curLine)
  }
  const daily = payload.daily
  if (daily?.time && daily.temperature_2m_max) {
    const days = Math.min(3, daily.time.length)
    const parts: string[] = []
    for (let i = 0; i < days; i += 1) {
      const c = codeText(daily.weather_code?.[i], lang)
      const hi = daily.temperature_2m_max[i] != null ? Math.round(daily.temperature_2m_max[i]) : null
      const lo = daily.temperature_2m_min?.[i] != null ? Math.round(daily.temperature_2m_min[i]) : null
      const tempRange = hi != null && lo != null ? `，${hi}到${lo}度` : (hi != null ? `，最高${hi}度` : '')
      const pop = daily.precipitation_probability_max?.[i]
      if (prefix === 'en') {
        const date = daily.time[i]?.slice(5) ?? ''
        parts.push(`${dayWords(i, daily.time[i])} ${date} ${c}${tempRange}${pop != null ? `, ${pop}% rain` : ''}`)
      } else {
        parts.push(`${dayWords(i, daily.time[i])}${c}${tempRange}${rainWords(pop)}`)
      }
    }
    lines.push((prefix === 'en' ? 'Coming days: ' : '接下来几天：') + parts.join('；') + '。')
  }
  // 温馨提示：按当前天气给一条「注意什么/适合什么」（用户要求），未知天气不硬凑
  const tip = weatherTip(cur.weather_code, lang)
  if (tip) lines.push((prefix === 'en' ? 'Tip: ' : '温馨提示：') + tip)
  return lines.join('')
}

/**
 * 创建「获取当前位置天气」工具；无需入参，经纬度来自客户端上报的位置。
 * 天气来源通过 WeatherSource 注入（默认 wttr.in），换源只改注入、不动工具逻辑；
 * 底层 fetcher 也注入给 source，便于测试不联网。
 * 返回 AgentScope 的 Tool 描述（name / description / inputSchema / call）。
 */
export function createWeatherTool(
  lang: Lang | string,
  locationProvider: LocationProvider,
  source: WeatherSource = createDefaultWeatherSource(),
  requestLocation?: RequestLocation,
  fetcher: WeatherFetcher = globalThis.fetch as unknown as WeatherFetcher
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const descriptions: Record<string, string> = {
    zh: '获取天气（当前温度、体感、湿度、风力，及今天/明天/后天的预报和降水）。可传 city 查询指定城市（如“北京天气”），不传则查设备当前位置。当用户问“天气”“下雨吗”“今天多少度”“北京天气”时调用，不要凭记忆回答。',
    en: "Get the weather (current temperature, feels-like, humidity, wind, and today/tomorrow/day-after forecast with rain chance). Pass city for a specific city (e.g. 'weather in Beijing'); omit for the device's current location. Call when the user asks about weather; do not answer from memory.",
  }
  return {
    name: WEATHER_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({ city: z.string().optional().describe('城市名，如“北京”；不传查当前位置') }),
    call: async (args?: { city?: string }): Promise<string> => {
      const city = typeof args?.city === 'string' ? args.city.trim() : ''
      try {
        // 指定城市：走 source.fetchCity（wttr.in 直接吃城市名，免费无需 geocoding）
        if (city && source.fetchCity) {
          const data = await source.fetchCity(city, fetcher)
          if (!data || typeof data.current?.temperature_2m !== 'number') {
            return prefix === 'en'
              ? `Could not get weather for ${city}.`
              : `没查到${city}的天气。`
          }
          // 用城市名作播报地名，不再显示经纬度
          return formatWeather(lang, { latitude: 0, longitude: 0, address: city }, data)
        }
        // 未指定城市：走设备定位
        let loc = locationProvider()
        if ((!loc || typeof loc.latitude !== 'number') && requestLocation) {
          loc = await requestLocation()
        }
        if (!loc || typeof loc.latitude !== 'number') {
          return prefix === 'en'
            ? 'Current location is unavailable, so I cannot fetch the weather.'
            : '当前位置未获取到，无法查询天气。'
        }
        const data = await source.fetch(loc.latitude, loc.longitude, fetcher)
        if (!data || typeof data.current?.temperature_2m !== 'number') {
          return prefix === 'en'
            ? 'Weather service returned an error.'
            : '天气服务返回异常。'
        }
        return formatWeather(lang, loc, data)
      } catch {
        return prefix === 'en'
          ? 'Could not reach the weather service.'
          : '无法连接天气服务。'
      }
    },
  }
}
