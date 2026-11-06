import { z } from 'zod'
import type { Lang } from '../../protocol'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const TIME_TOOL_NAME = 'get_current_time'

/** 把 IANA 时区解析成「名称 + 偏移」，例如 Asia/Shanghai +08:00；解析失败回退到名称本身。 */
function zoneLabel(timezone?: string): string {
  if (!timezone) return ''
  try {
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value
    return offset ? `${timezone} ${offset.replace('GMT', 'UTC')}` : timezone
  } catch {
    return timezone
  }
}

/** 按语言把当前时间格式化成可读字符串，交给大模型组织进回答。timezone 缺省为东八区（Asia/Shanghai）。 */
export function formatNow(lang: Lang | string, timezone: string = 'Asia/Shanghai'): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const locale = prefix === 'en' ? 'en-US' : prefix === 'ja' ? 'ja-JP' : 'zh-CN'
  const now = new Date()
  const dateOpts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }
  if (timezone) {
    dateOpts.timeZone = timezone
    timeOpts.timeZone = timezone
  }
  const date = new Intl.DateTimeFormat(locale, dateOpts).format(now)
  const time = new Intl.DateTimeFormat(locale, timeOpts).format(now)
  const zone = zoneLabel(timezone)
  return zone ? `${date} ${time} (${zone})` : `${date} ${time}`
}

/** 工具描述随语言本地化，让对应语言的模型也能正确调用。 */
const DESCRIPTIONS: Record<string, string> = {
  zh: '获取当前的日期和时间（年、月、日、星期、时、分、秒）。当用户问“现在几点”“今天几号”“星期几”等时间相关问题时调用此工具，不要凭记忆回答。返回的是用户所在时区的时间。',
  en: "Get the current date and time (year, month, day, weekday, hour, minute, second). Call this whenever the user asks about the current time, today's date, or the day of the week; do not answer from memory. The result is in the user's timezone.",
  ja: '現在の日付と時刻（年・月・日・曜日・時・分・秒）を取得する。ユーザーが「今何時」「今日は何日」「曜日」など時間に関する質問をしたら、記憶に頼らずこのツールを呼ぶ。返り値はユーザーの現地時刻。',
}

/**
 * 创建一个「获取当前时间」工具；无需入参，返回值由网关本地时钟按用户时区决定。
 * timezone 缺省为东八区（Asia/Shanghai），可由网关配置覆盖。
 * 返回 AgentScope 的 Tool 描述（name / description / inputSchema / call）。
 */
export function createCurrentTimeTool(lang: Lang | string, timezone: string = 'Asia/Shanghai') {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: TIME_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({}),
    call: () => formatNow(lang, timezone),
  }
}
