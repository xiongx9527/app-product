/** 解析出的可播放曲目：客户端据此用独立播放器播放，不与 TTS 冲突。 */
export interface ResolvedTrack {
  /** 可直接交给播放器的音频流地址（mp3 / m3u8 / 直链） */
  url: string
  /** 展示用标题 */
  title: string
  /** 来源标识（频道名 / 服务商 id），便于客户端展示 */
  channel?: string
}

/** 音乐播放源抽象：给定风格返回可播放曲目（可异步，如需要联网搜歌的厂商）。 */
export interface MusicSource {
  resolve(genre?: string): ResolvedTrack | Promise<ResolvedTrack>
  /**
   * 换一首 / 下一首 / 换个风格：返回与当前不同的曲目。
   * 不传 genre 表示「同类型换一首」；传 genre 表示「换个风格」。
   * 可选——没有「下一首」概念的源可不实现，调用方据此回退到 resolve。
   */
  next?(genre?: string): ResolvedTrack | Promise<ResolvedTrack>
}

/** 可注入的 fetch：便于单测用桩替换，缺省走全局 fetch。 */
export interface MusicFetcher {
  (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    /** 跟随重定向后的最终地址；用于从百度 /link?url= 跳转里拿真实视频页地址 */
    url?: string
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

/**
 * 泛化点歌词：用户只说「放首歌/播放个/随便放点」，没有点名歌名/歌手/风格。
 * 这类词拿去百度搜「歌 视频 在线听」几乎抽不到音轨，会白报「操作失败」，
 * 应回落到轻音乐电台（SomaFM），由 isGenreRequest 判为风格请求。
 */
const GENERIC_PLAY_WORDS =
  /^(歌|歌曲|音乐|乐曲|曲子|曲|个|首|点|些|一点的?|一些|随便|随便来|随便放|随便听|都行|什么都行|任意|来点|放点|听点|来首歌|放首歌|点首歌|听首歌|放个歌|播个|播放个|点点|呗|吧|啊|呢)*$/

/** 把风格描述/歌名收敛成搜索词；无匹配给兜底词。 */
export function genreToKeyword(genre?: string): string {
  if (!genre) return '轻音乐'
  const trimmed = genre.trim()
  // 先按风格词映射（轻音乐/电子/爵士…），命中直接返回该风格词
  for (const entry of GENRE_KEYWORDS) {
    if (entry.match.test(trimmed)) return entry.keyword
  }
  // 否则当具体歌名/歌手处理：去掉指令性填充词与“的”
  let kw = trimmed
  for (const word of COMMAND_WORDS) {
    kw = kw.split(word).join('')
  }
  kw = kw.replace(/的/g, ' ').replace(/\s+/g, ' ').trim()
  // 剔除后只剩泛化词/语气词（或为空）→ 回落轻音乐电台，别拿去百度白搜
  const compact = kw.replace(/\s+/g, '')
  if (!compact || GENERIC_PLAY_WORDS.test(compact)) return '轻音乐'
  // 「播放个周杰伦的稻香」这类：指令词删掉后残留开头的量词「个/首/点」，去掉再搜
  return kw.replace(/^[个首点些]+\s*/, '').trim() || '轻音乐'
}

/**
 * 判断用户的描述是否“风格/氛围”请求（轻音乐/电子/爵士…），而非具体歌名/歌手。
 * 聚合音乐源据此分流：风格走 SomaFM 电台，点歌走百度搜索兜底。
 */
export function isGenreRequest(genre?: string): boolean {
  if (!genre) return true
  const trimmed = genre.trim()
  return GENRE_KEYWORDS.some((entry) => entry.match.test(trimmed))
}

/** 用户口头指令里常见的填充词，从歌名里剔除（不会出现在歌名/歌手名中）。 */
const COMMAND_WORDS: string[] = [
  '我想听',
  '我要听',
  '来听',
  '听一首',
  '来一首',
  '播放',
  '放歌',
  '放首',
  '点一首',
  '点首',
  '唱一首',
  '唱首',
  '整首',
  '放点',
  '来点',
  '给我',
  '换一首',
  '换首',
  '下一首',
  '换个风格',
  '换风格',
  '切歌',
  '来点别的',
]

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
