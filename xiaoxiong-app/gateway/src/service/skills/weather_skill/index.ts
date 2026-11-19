/**
 * 天气 skill：问天气 → 调天气数据源口播，绕开大模型。
 *
 * 业务归属（用户要求 control/ 跟 skill 走）：detect（原 control/weatherControl.ts）
 * + 城市提取 + run（原 voiceSessionService.runWeatherCommand）+ 文案格式化（原 weatherTool
 * 的 formatWeather/WEATHER_CODE/WEATHER_TIPS，见 ./format.ts）全自包含在这个目录。
 * 网关编排层只按 priority 把话递给 onDirectCommand，不含天气业务。
 * weatherTool.ts 后续会删除，本 skill 绝不依赖它。
 *
 * 源可替换（用户要求「换源不改 skill」）：本目录依赖 `WeatherSource` 抽象（在 weather/ 域），
 * 默认用 createDefaultWeatherSource()（wttr.in），换源只改注入的 source 实现，detect/run/
 * format 代码零改动。全局 types.ts 不含任何源。测试可注入 stub source 不联网。
 *
 * 踩坑（真机）：城市名取天气意图词之前的名词片段、剥口语前缀；只取 ≤10 字，
 * 避免把整句当城市名。无城市名才用设备定位（懒加载，不主动弹权限框）。
 */
import {
  createDefaultWeatherSource,
  type WeatherSource,
  type WeatherFetcher,
} from './weather'
import { formatWeather } from './format'
import { pickI18n } from './i18n'
import type { Skill, SkillContext, SkillModule } from '../types'

const WEATHER_INTENT =
  /天气|气温|多少度|几度|温度|下不下雨|会不会下雨|要下雨|带伞|冷不冷|热不热|穿什么|降温|升温|空气湿度|天气预报/

/** 文本是否为天气查询。 */
export function detectWeatherCommand(text: string): boolean {
  const t = text.trim()
  return !!t && WEATHER_INTENT.test(t)
}

const CITY_FILLERS = [
  '帮我', '请', '查一下', '查询一下', '查查', '查询', '查', '看一下', '看看', '看下',
  '问下', '问一下', '告诉我', '给我', '说一下', '说说', '播报一下', '播报',
  '今天', '今日', '明天', '现在', '这会儿', '的', '天气', '在',
]

/** 从天气问句提城市名（「北京天气怎么样」→「北京」）；无则 null（查当前位置）。 */
export function extractWeatherCity(text: string): string | null {
  const t = (text || '').trim()
  if (!t) return null
  const intentIdx = t.search(WEATHER_INTENT)
  if (intentIdx <= 0) return null
  let s = t.slice(0, intentIdx).trim()
  let changed = true
  while (changed) {
    changed = false
    for (const w of CITY_FILLERS) {
      if (s.startsWith(w)) { s = s.slice(w.length).trim(); changed = true }
    }
  }
  s = s.replace(/的$/, '').trim()
  s = s.replace(/^[，,。.、\s？?！!]+|[，,。.、\s？?！!]+$/g, '').trim()
  if (!s || s.length > 10) return null
  if (/^(今天|今日|明天|后天|现在|这会儿|当地|这里)$/.test(s)) return null
  return s
}

/**
 * 查天气并格式化成口播文本：指定城市走 source.fetchCity；否则用设备定位（懒加载）。
 * 不依赖 weatherTool——直接 WeatherSource + 定位 + formatWeather。
 */
async function queryWeather(
  ctx: SkillContext,
  source: WeatherSource,
  city: string | undefined,
  fetcher?: WeatherFetcher,
): Promise<string> {
  const lang = ctx.lang
  const i = pickI18n(lang)
  // fetcher 缺省用全局 fetch（WeatherFetcher 签名与 fetch 兼容）；测试可注入桩不联网。
  const f: WeatherFetcher = fetcher ?? (fetch as unknown as WeatherFetcher)
  if (city && source.fetchCity) {
    const data = await source.fetchCity(city, f)
    if (!data || typeof data.current?.temperature_2m !== 'number') return i.notFound(city)
    // 城市名作播报地名，不显示经纬度
    return formatWeather(lang, { latitude: 0, longitude: 0, address: city }, data)
  }
  let loc = ctx.getLocation?.()
  if ((!loc || typeof loc.latitude !== 'number') && ctx.requestClientLocation) {
    loc = await ctx.requestClientLocation()
  }
  if (!loc || typeof loc.latitude !== 'number') return i.noLocation()
  const data = await source.fetch(loc.latitude, loc.longitude, f)
  if (!data || typeof data.current?.temperature_2m !== 'number') return i.serviceError()
  return formatWeather(lang, loc, data)
}

function makeWeatherSkill(ctx: SkillContext, source: WeatherSource, fetcher?: WeatherFetcher): Skill {
  return {
    async onDirectCommand(text) {
      if (!detectWeatherCommand(text)) return undefined
      const city = extractWeatherCity(text) ?? undefined
      try {
        await ctx.speak(await queryWeather(ctx, source, city, fetcher))
      } catch {
        await ctx.speak(pickI18n(ctx.lang).serviceError())
      }
      return { consumed: true }
    },
  }
}

/** 工厂：默认用内置天气源；换源传自定义 source 即可，detect/run/format 不变。 */
export function createWeatherSkill(source?: WeatherSource, fetcher?: WeatherFetcher): SkillModule {
  return {
    id: 'weather',
    name: '天气查询',
    priority: 30, // 原 handleDirectCommand 顺序：择吉日(10) < 时间(20) < 天气(30)
    description: () => '', // 纯代码钩子型：天气查询由意图识别直连处理
    create: (ctx) => makeWeatherSkill(ctx, source ?? createDefaultWeatherSource(), fetcher),
  }
}

/** 默认装配（registry 用）：可被注入替换实现换源。 */
export const weatherSkill: SkillModule = createWeatherSkill()
