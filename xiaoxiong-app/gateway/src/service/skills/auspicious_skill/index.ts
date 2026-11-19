/**
 * 择吉日 skill：问吉日/黄历宜忌 → 用 lunar-javascript 内置权威黄历数据扫未来日期口播。
 *
 * 业务归属（用户要求 control/ 跟 skill 走）：detect（原 control/auspiciousControl.ts）
 * + run（原 voiceSessionService.runAuspiciousCommand）+ i18n（./i18n.ts）全自包含。
 * 网关编排层只按 priority 把话递给 onDirectCommand，不含择日业务。
 *
 * 无外部数据源（黄历宜忌是 lunar 库内置的传统历法数据，非编造），零网络零 LLM。
 * 与日期直连(time_skill)区分：「今天什么日子」问的是几号(time_skill)，
 * 「推荐个吉日/好日子」含吉日触发词才进这里。
 *
 * 踩坑（真机，迁代码时注释一起搬来）：
 *  - 起点日按会话时区取（en-GB parts 手法，不依赖进程本地时区），UTC 时间轴逐日 +1 无漂移；
 *  - Solar.fromYmd 按 Y/M/D 构造（不用 fromDate，避免依赖进程本地时区）；
 *  - 日期/星期/农历串固定中文，small-ICU 下 Intl 中文会 fallback 成英文，故星期用固定映射表。
 */
import { Solar } from 'lunar-javascript'
import type { Skill, SkillContext, SkillModule } from '../types'
import { pickI18n } from './i18n'

const AUSPICIOUS_TRIGGER = /吉日|黄道吉日|良辰|好日子|黄历|宜忌|择日/

/** 常见事项 → 黄历「宜」词映射：口语词命中后按黄历标准词匹配宜列表。 */
const ACTIVITY_WORDS: Array<{ re: RegExp; label: string; yi: string[] }> = [
  { re: /结婚|嫁娶|办喜事|喜酒|婚期/, label: '嫁娶', yi: ['嫁娶'] },
  { re: /领证|结婚登记/, label: '领证', yi: ['嫁娶', '纳采'] },
  { re: /订婚|提亲/, label: '订婚', yi: ['纳采', '订盟'] },
  { re: /搬家|搬屋|迁居|乔迁/, label: '搬家', yi: ['移徙', '入宅'] },
  { re: /入住|进宅|入伙/, label: '入住', yi: ['入宅', '移徙'] },
  { re: /开业|开张|开店|开工/, label: '开业', yi: ['开市', '交易', '立券'] },
  { re: /装修|动土|破土动工/, label: '动土', yi: ['动土', '修造'] },
  { re: /出行|旅游|旅行|出门|远行/, label: '出行', yi: ['出行'] },
  { re: /签约|签合同|签协议/, label: '签约', yi: ['立券', '交易'] },
  { re: /安床/, label: '安床', yi: ['安床'] },
  { re: /祭祀|祭拜|上香|扫墓/, label: '祭祀', yi: ['祭祀'] },
  { re: /祈福|还愿|拜佛/, label: '祈福', yi: ['祈福'] },
  { re: /求子/, label: '求嗣', yi: ['求嗣'] },
  { re: /安葬|下葬/, label: '安葬', yi: ['安葬', '破土'] },
  { re: /提车/, label: '提车', yi: ['出行', '纳财'] },
  { re: /进货|收账|收租|进财/, label: '纳财', yi: ['纳财', '开仓'] },
]

const WEEKDAY_ZH: Record<string, string> = {
  Sun: '星期日', Mon: '星期一', Tue: '星期二', Wed: '星期三',
  Thu: '星期四', Fri: '星期五', Sat: '星期六',
}

export interface AuspiciousQuery {
  activity: string | null
  yiWords: string[]
}

/** 识别择吉日意图：null 表示不是这类句子，交给后续 skill / LLM。 */
export function detectAuspiciousQuery(text: string): AuspiciousQuery | null {
  const t = text.trim()
  if (!t || !AUSPICIOUS_TRIGGER.test(t)) return null
  for (const a of ACTIVITY_WORDS) {
    if (a.re.test(t)) return { activity: a.label, yiWords: a.yi }
  }
  return { activity: null, yiWords: [] }
}

function createAuspiciousSkill(ctx: SkillContext): Skill {
  return {
    async onDirectCommand(text) {
      const q = detectAuspiciousQuery(text)
      if (!q) return undefined

      const i = pickI18n(ctx.lang)
      // 起点日按会话时区取（en-GB parts，不依赖进程本地时区）
      const todayParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ctx.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      }).formatToParts(new Date())
      const pick = (type: string) => todayParts.find((p) => p.type === type)?.value ?? ''
      const startY = Number(pick('year'))
      const startMo = Number(pick('month'))
      const startD = Number(pick('day'))
      // UTC 时间轴逐日 +1（无时区漂移），每格按序号构造 Solar.fromYmd
      const baseMs = Date.UTC(startY, startMo - 1, startD)
      const SCAN_DAYS = 30
      const REPORT_LIMIT = 3
      const matched: string[] = []
      for (let day = 0; day < SCAN_DAYS && matched.length < REPORT_LIMIT; day += 1) {
        const dt = new Date(baseMs + day * 86400000)
        const y = dt.getUTCFullYear()
        const mo = dt.getUTCMonth() + 1
        const d = dt.getUTCDate()
        const weekday = WEEKDAY_ZH[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]] ?? ''
        const lunar = Solar.fromYmd(y, mo, d).getLunar()
        const yi = lunar.getDayYi()
        const leap = lunar.getMonth() < 0 ? '闰' : ''
        // 带事项：只报日期；泛吉日：顺带报当天前 3 个宜词
        const dayLabel =
          `${mo}月${d}日（${weekday}，农历${leap}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`
          + (q.yiWords.length ? '' : `，宜${yi.slice(0, 3).join('、')}`) + '）'
        const isMatch =
          q.yiWords.length > 0
            ? q.yiWords.some((w) => yi.includes(w))
            : yi.length >= 4
        if (isMatch) matched.push(dayLabel)
      }
      if (!matched.length) {
        await ctx.speak(i.none(q.activity ?? '这件事'))
        return { consumed: true }
      }
      const daysText = matched.join('、')
      await ctx.speak(q.activity ? i.found(q.activity, daysText) : i.best(daysText))
      return { consumed: true }
    },
  }
}

export const auspiciousSkill: SkillModule = {
  id: 'auspicious',
  name: '择吉日查询',
  priority: 10, // 原 handleDirectCommand 最靠前：择吉日 < 时间(20) < 天气(30)
  description: () => '', // 纯代码钩子型：择日由意图识别直连处理
  create: createAuspiciousSkill,
}
