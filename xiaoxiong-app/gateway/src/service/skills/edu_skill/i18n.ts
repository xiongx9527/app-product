/**
 * 诗词/古文朗读文案（纯数据，不 import 网关 i18n.ts，避免循环依赖）。
 */
export const poemI18n = {
  'zh-CN': {
    prompt: () => '想背哪首？说个诗词名，比如「背诵滕王阁序」。',
    notFound: (title: string) => `暂时没找到《${title}》的诗词内容。`,
    playing: (author: string | undefined, title: string) =>
      `找到${author ? author + '的' : ''}《${title}》，正在为你朗读。`,
  },
  en: {
    prompt: () => 'Which poem would you like?',
    notFound: (title: string) => `Sorry, I couldn't find "${title}".`,
    playing: (author: string | undefined, title: string) =>
      `Found "${title}"${author ? ` by ${author}` : ''}.`,
  },
}

export function pickPoemI18n(lang: string) {
  return lang.toLowerCase().startsWith('en') ? poemI18n.en : poemI18n['zh-CN']
}
