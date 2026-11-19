/**
 * 音乐播放器的口播文案（跟 music_skill 走，纯数据、不 import 网关 i18n.ts 避免循环）。
 * 措辞注意：评书/戏曲/影视等非歌曲内容，notFound(spoken=true) 说「这段内容」不说「这首歌」。
 */
export interface MusicI18n {
  playing: (title: string) => string
  switched: (title: string) => string
  notFound: (spoken: boolean) => string
  notImplemented: (kind: string) => string
  candidates: (items: string[]) => string
  chooseHint: () => string
  chooseAgain: () => string
  recommend: (items: string[]) => string
  recommendPrompt: () => string
  offerOtherType: () => string
  switchedOther: () => string
}

export const musicI18n: Record<string, MusicI18n> = {
  'zh-CN': {
    playing: (title) => `正在为你播放：${title}。`,
    switched: (title) => `已为你切换到：${title}。`,
    notFound: (spoken) => (spoken ? '没找到这段内容，换个名字试试？' : '没找到这首歌，换个名字或歌手试试？'),
    notImplemented: (kind) => `播放源「${kind}」尚未实现，暂不可用，请到设置里改用「百度搜索」。`,
    candidates: (items) => `找到几首：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}首，${it}`).join('；')}。`,
    chooseHint: () => '你想听第几首，或者说出歌名？',
    chooseAgain: () => '没听清选哪首，请说第几首或歌名。',
    recommend: (items) => `为你推荐：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}首，${it}`).join('；')}。`,
    recommendPrompt: () => '想听点什么风格，或者告诉我歌手，我帮你挑几首？',
    offerOtherType: () => '没找到同类型的其它内容，要我直接换点别的，还是你自己点名想听的？',
    switchedOther: () => '没找到同类型的其它内容，给你换点别的。',
  },
  en: {
    playing: (title) => `Now playing: ${title}.`,
    switched: (title) => `Switched to: ${title}.`,
    notFound: (spoken) => (spoken ? "Couldn't find that content. Try another name?" : "Couldn't find that song. Try another title or artist?"),
    notImplemented: (kind) => `The music source "${kind}" is not yet available. Please switch to "Baidu Search" in settings.`,
    candidates: (items) => `Found some songs: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one? Say the number or the song title.',
    chooseAgain: () => "Didn't catch which song. Say the number or the title.",
    recommend: (items) => `Here are some picks: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    recommendPrompt: () => "What style are you in the mood for, or name an artist and I'll pick a few?",
    offerOtherType: () => 'No other content of the same type found. Shall I switch to something else, or would you name one?',
    switchedOther: () => 'No other content of the same type found; switching to something else.',
  },
}

export function pickI18n(lang: string): MusicI18n {
  if (musicI18n[lang]) return musicI18n[lang]
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return musicI18n[prefix] ?? musicI18n['zh-CN']
}
