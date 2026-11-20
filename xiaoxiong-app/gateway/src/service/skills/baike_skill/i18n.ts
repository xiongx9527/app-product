/**
 * 百科查询文案（纯数据，不 import 网关 i18n.ts，避免循环依赖）。
 */
export const baikeI18n = {
  'zh-CN': {
    prompt: () => '想查谁的百科？比如说「百科李存勖」。',
    playing: (title: string) => `正在为你播报：${title}。`,
    unavailable: () => '我这次没连上，稍后再试。',
  },
  en: {
    prompt: () => 'Whose encyclopedia entry? For example, "wiki Einstein".',
    playing: (title: string) => `Now reading the encyclopedia entry for: ${title}.`,
    unavailable: () => "I couldn't connect this time. Could you ask me again in a moment?",
  },
}

export function pickBaikeI18n(lang: string) {
  return lang.toLowerCase().startsWith('en') ? baikeI18n.en : baikeI18n['zh-CN']
}
