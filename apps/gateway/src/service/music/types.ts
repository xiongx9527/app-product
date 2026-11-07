/** 解析出的可播放曲目：客户端据此用独立播放器播放，不与 TTS 冲突。 */
export interface ResolvedTrack {
  /** 可直接交给播放器的音频流地址（mp3 / m3u8 / 直链） */
  url: string
  /** 展示用标题 */
  title: string
  /** 来源标识（频道名 / 服务商 id），便于客户端展示 */
  channel?: string
}

/** 音乐播放源抽象：给定风格返回可播放曲目。各厂商各自实现。 */
export interface MusicSource {
  resolve(genre?: string): ResolvedTrack
}

/** 音乐播放源厂商：与客户端设置页的厂商 id 对齐。 */
export type MusicProviderKind = 'soma' | 'custom' | 'netease' | 'qq' | 'spotify'

/** 客户端上报的音乐配置（已拍平为当前选中厂商的参数）。 */
export interface MusicConfig {
  provider: MusicProviderKind
  params: Record<string, string | number | boolean>
}

/** 可注入的 fetch：便于单测用桩替换，缺省走全局 fetch。 */
export interface MusicFetcher {
  (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

/** 风格关键词 → 搜索词；各正版服务按它去搜歌，找不到就用兜底词。 */
const GENRE_KEYWORDS: Array<{ match: RegExp; keyword: string }> = [
  { match: /(轻音乐|放松|舒缓|纯音乐|背景)/, keyword: '轻音乐' },
  { match: /(电子|edm|电音)/, keyword: '电子' },
  { match: /(爵士|jazz)/, keyword: '爵士' },
  { match: /(流行|pop)/, keyword: '流行' },
  { match: /(古典|classical)/, keyword: '古典' },
  { match: /(摇滚|rock)/, keyword: '摇滚' },
  { match: /(嘻哈|说唱|hiphop|rap)/, keyword: '嘻哈' },
  { match: /(民谣|folk)/, keyword: '民谣' },
  { match: /(乡村|country)/, keyword: '乡村' },
  { match: /(睡眠|助眠|白噪音)/, keyword: '睡眠' },
]

/** 把风格描述收敛成搜索词；无匹配给兜底词。 */
export function genreToKeyword(genre?: string): string {
  if (!genre) return '轻音乐'
  for (const entry of GENRE_KEYWORDS) {
    if (entry.match.test(genre)) return entry.keyword
  }
  return genre.trim() || '轻音乐'
}

/** 取参数的字符串值，缺省给 fallback。 */
export function paramString(
  params: Record<string, string | number | boolean>,
  key: string,
  fallback = ''
): string {
  const value = params[key]
  if (value === undefined || value === null) return fallback
  return String(value)
}
