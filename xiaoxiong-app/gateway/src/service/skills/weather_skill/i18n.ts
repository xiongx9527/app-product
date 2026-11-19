/**
 * 天气 skill 的文案（跟 skill 走），纯数据、不 import 网关 i18n.ts（避免循环依赖）。
 * 只放天气直连的兜底提示；天气正文的格式化文案在 ./format.ts（口语化 + 温馨提示）。
 */
export interface WeatherI18n {
  notFound: (city: string) => string
  noLocation: () => string
  serviceError: () => string
}

export const weatherI18n: Record<string, WeatherI18n> = {
  'zh-CN': {
    notFound: (city) => `没查到${city}的天气。`,
    noLocation: () => '当前位置未获取到，无法查询天气。',
    serviceError: () => '天气服务返回异常。',
  },
  en: {
    notFound: (city) => `Could not get weather for ${city}.`,
    noLocation: () => 'Current location is unavailable, so I cannot fetch the weather.',
    serviceError: () => 'Weather service returned an error.',
  },
}

/** 按语言码取，带地区码按前缀回退（en-US→en）。 */
export function pickI18n(lang: string): WeatherI18n {
  if (weatherI18n[lang]) return weatherI18n[lang]
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return weatherI18n[prefix] ?? weatherI18n['zh-CN']
}
