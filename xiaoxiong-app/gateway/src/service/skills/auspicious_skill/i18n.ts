/**
 * 择吉日 skill 的文案（跟 skill 走），纯数据、不 import 网关 i18n.ts（避免循环依赖）。
 * 日期/宜忌串固定中文（历法表述不随语言英化，与日期直连同口径），只换外层连接词。
 */
export interface AuspiciousI18n {
  found: (activity: string, days: string) => string
  best: (days: string) => string
  none: (activity: string) => string
}

export const auspiciousI18n: Record<string, AuspiciousI18n> = {
  'zh-CN': {
    found: (activity, days) => `帮你翻了黄历，最近的宜${activity}吉日：${days}。`,
    best: (days) => `帮你翻了黄历，最近最合适的日子：${days}。`,
    none: (activity) => `这一个月的黄历里都没找到宜${activity}的日子，换个事项或过阵子再问问我吧。`,
  },
  en: {
    found: (activity, days) => `Checked the almanac. Upcoming auspicious days for ${activity}: ${days}.`,
    best: (days) => `Checked the almanac. The most suitable upcoming days: ${days}.`,
    none: (activity) => `No almanac day for ${activity} in the coming month. Try another activity or ask again later.`,
  },
}

export function pickI18n(lang: string): AuspiciousI18n {
  if (auspiciousI18n[lang]) return auspiciousI18n[lang]
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return auspiciousI18n[prefix] ?? auspiciousI18n['zh-CN']
}
