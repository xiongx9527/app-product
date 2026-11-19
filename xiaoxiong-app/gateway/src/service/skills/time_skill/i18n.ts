/**
 * 时间 skill 的文案（跟 skill 走，用户要求「每个 skill 目录自带 i18n」）。
 *
 * 纯数据模块：只导出 zh-CN/en 两份文案片段，不 import 网关 i18n.ts（避免循环依赖）——
 * 网关 i18n.ts 反过来 import 这里做汇总，time_skill/index.ts 通过 messages().clock 取用。
 *
 * 踩坑（真机）：日期里的历法表述固定中文，不随 lang 英化——英文月份/星期在设备端
 * small-ICU 下会 fallback 成乱码式表达，用户明确要求日期不英化。故 date() 两个语言都
 * 保留中文 dateBody/weekday/lunar，只换外层连接词。
 */

export interface ClockI18n {
  now: (h: number, m: number) => string
  /** dateBody=「2026年11月16日」weekday=「星期一」lunar=「农历十月初八」，固定中文 */
  date: (dateBody: string, weekday: string, lunar: string) => string
}

export const clockI18n: Record<string, ClockI18n> = {
  'zh-CN': {
    now: (h, m) => (m ? `现在是${h}点${m}分。` : `现在是${h}点整。`),
    date: (dateBody, weekday, lunar) => `今天是${dateBody}，${weekday}，${lunar}。`,
  },
  en: {
    now: (h, m) => (m ? `It's ${h}:${String(m).padStart(2, '0')}.` : `It's ${h} o'clock.`),
    date: (dateBody, weekday, lunar) => `Today is ${dateBody} ${weekday} (${lunar}).`,
  },
}
