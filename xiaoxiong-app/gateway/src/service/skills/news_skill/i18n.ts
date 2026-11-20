/**
 * 新闻播报文案（纯数据，不 import 网关 i18n.ts，避免循环依赖）。
 */
export const newsI18n = {
  'zh-CN': {
    playing: (title: string) => `正在为你播报：${title}。`,
    none: (keyword?: string) =>
      keyword ? `暂时没查到与「${keyword}」相关的新闻。` : '暂时没查到新闻。',
    unavailable: () => '现在查不了新闻，稍后再试。',
    candidates: (items: readonly string[]) =>
      `找到几条新闻：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}条，${it}`).join('；')}。`,
    chooseHint: () => '你想听第几条？',
    noMore: () => '这几条新闻都播完啦，说「播放新闻」再给你找几条。',
  },
  en: {
    playing: (title: string) => `Now playing the news: ${title}.`,
    none: (keyword?: string) =>
      keyword ? `No news found about "${keyword}".` : 'No news found right now.',
    unavailable: () => "Can't fetch news right now. Please try again later.",
    candidates: (items: readonly string[]) =>
      `Found a few news videos: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one would you like to play?',
    noMore: () => "That's all the news for now. Say 'play news' to get more.",
  },
}

export function pickNewsI18n(lang: string) {
  return lang.toLowerCase().startsWith('en') ? newsI18n.en : newsI18n['zh-CN']
}
