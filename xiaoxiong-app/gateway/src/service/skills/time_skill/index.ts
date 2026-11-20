/**
 * 时间 skill：问时间/日期 → 本地时钟 + 农历直接口播，绕开大模型。
 *
 * 业务归属（用户要求 control/ 的东西跟对应 skill 走）：本 skill 自包含「意图识别」
 * （原 control/timeControl.ts 的 detect）+「执行」（原 voiceSessionService.runTimeCommand）。
 * 网关编排层只负责按 priority 把用户这句话递给 onDirectCommand，不含任何时间业务。
 *
 * 无外部数据源（用本地时钟 + lunar-javascript），因此不违反「types.ts 不含源」的约束。
 * 需要换源/换历法实现的 skill 在各自目录内定义接口+默认实现并支持注入，与这里同构。
 *
 * 踩坑（真机实测，迁代码时这些注释一起搬来，不许丢）：
 *  - 设备端 NodeMobile 是 small-ICU，Intl.DateTimeFormat('zh-CN') 会静默 fallback 成英文
 *    （报出 "November 16, 2026"）。故数字用 en-GB 取、中文年月日/星期自己拼、星期用固定映射表。
 *  - 农历必须用 Solar.fromYmd（会话时区算出的 Y/M/D）构造，不能用 Solar.fromDate（依赖进程本地时区）。
 *  - 「今天星期几」只报时分是漏答，日期类要给全「X年X月X日 星期X 农历…」+ 时分。
 */
import { Solar } from 'lunar-javascript'
// 直接用本 skill 目录自带的文案（不绕网关 messages() 聚合器）——文案跟 skill 走，
// skill 自包含 detect+run+i18n。按 lang 前缀取（客户端可能上报 en-US / zh-TW 等）。
import { clockI18n } from './i18n'
import type { Skill, SkillContext, SkillModule } from '../types'

/** 按语言码取本 skill 文案，带地区码按前缀回退（en-US→en、zh-TW→zh-CN）。 */
function pickI18n(lang: string) {
  if (clockI18n[lang]) return clockI18n[lang]
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return clockI18n[prefix] ?? clockI18n['zh-CN']
}

/** 问时间：答案只是时:分。 */
const TIME_WORDS = /几点|几时|报时|现在时间|当前时间|什么时间|什么时刻/
/** 问日期：答案含年月日 / 星期。 */
const DATE_WORDS =
  /几号|几月几[号日]|什么日期|什么日子|星期几|周几|礼拜几|今天几号|今天是[星期周几]|日历/

type TimeIntentKind = 'time' | 'date' | 'both'

/** 识别时间/日期意图：null 表示不是这类句子；'both' 表示一句里时间、日期都问了。 */
function detectTimeCommandKind(text: string): TimeIntentKind | null {
  const t = text.trim()
  if (!t) return null
  const time = TIME_WORDS.test(t)
  const date = DATE_WORDS.test(t)
  if (time && date) return 'both'
  if (time) return 'time'
  if (date) return 'date'
  return null
}

/** en-GB weekday short（Sun/Mon/...）→ 中文星期；映射表稳定，不依赖 ICU。 */
const WEEKDAY_ZH: Record<string, string> = {
  Sun: '星期日', Mon: '星期一', Tue: '星期二', Wed: '星期三',
  Thu: '星期四', Fri: '星期五', Sat: '星期六',
}

function createTimeSkill(ctx: SkillContext): Skill {
  return {
    matchesIntent(text) {
      return isTimeQuery(text)
    },
    async onDirectCommand(text) {
      const kind = detectTimeCommandKind(text)
      if (!kind) return undefined // 不是时间意图，交给后续 skill / LLM

      const m = pickI18n(ctx.lang)
      const now = new Date()
      const timeParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ctx.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now)
      const h = Number(timeParts.find((p) => p.type === 'hour')?.value ?? 0)
      const min = Number(timeParts.find((p) => p.type === 'minute')?.value ?? 0)
      if (kind === 'time') {
        await ctx.speak(m.now(h, min))
        return { consumed: true }
      }

      // 数字统一用 en-GB 拿（无 locale 问题），中文「年月日/星期」自己拼。
      const allParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ctx.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(now)
      const pick = (type: string) => allParts.find((p) => p.type === type)?.value ?? ''
      const y = Number(pick('year'))
      const mo = Number(pick('month'))
      const d = Number(pick('day'))
      const weekday = WEEKDAY_ZH[pick('weekday')] ?? ''
      const dateBody = `${y}年${mo}月${d}日`
      // 农历取自 lunar-javascript（权威数据，非编造）；闰月带「闰」字。
      // 用会话时区算出的 Y/M/D 构造，避免 Solar.fromDate 依赖进程本地时区。
      const lunar = Solar.fromYmd(y, mo, d).getLunar()
      const leap = lunar.getMonth() < 0 ? '闰' : ''
      const lunarText = `农历${leap}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`
      const dateText = m.date(dateBody, weekday, lunarText)
      await ctx.speak(kind === 'date' ? dateText : `${dateText}${m.now(h, min)}`)
      return { consumed: true }
    },
  }
}

export const timeSkill: SkillModule = {
  id: 'time',
  name: '时间日期查询',
  // 优先级按原 handleDirectCommand 顺序：择吉日 < 时间 < 天气 < ...（间隔 10 便于插入）。
  priority: 20,
  description: () => '', // 纯代码钩子型：不向 LLM 暴露提示词（时间查询由意图识别直连处理）
  create: createTimeSkill,
}

/** 导出给会话层「有效意图白名单」（VAD 短语音判断）复用，避免两处重复正则。 */
export const isTimeQuery = (text: string): boolean => detectTimeCommandKind(text) !== null

/** 导出给单测：验证 detect 行为。 */
export const _detectTimeCommandKind = detectTimeCommandKind
