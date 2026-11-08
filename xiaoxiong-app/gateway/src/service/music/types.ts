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
 * 这类词拿去视频搜索「歌 视频 在线听」几乎抽不到音轨，会白报「操作失败」，
 * 应回落到空串、由上层（isGenreRequest 把空串判为风格请求）路由到轻音乐电台（SomaFM）。
 * 回落空串而非「轻音乐」字面值：空串语义更干净——「没给具体点歌信息」，
 * 同时让推荐意图在没有任何歌手/风格时走「引导补充」分支，而非拿空泛词去搜索。
 */
const GENERIC_PLAY_WORDS =
  /^(歌|歌曲|音乐|乐曲|曲子|曲|个|首|点|些|一点的?|一些|随便|随便来|随便放|随便听|都行|什么都行|任意|来点|放点|听点|来首歌|放首歌|点首歌|听首歌|放个歌|播个|播放个|点点|呗|吧|啊|呢)*$/

/**
 * 可播放的「非歌曲类内容」类型词。两个用途：
 *  1) 判断用户要的是不是歌曲（失败措辞：说评书/相声时不能回「没找到这首歌」）；
 *  2) 模糊匹配时先把这些通用类型词剔掉，避免「评书」这种泛词把不同作品撞到一起。
 *
 * 排序要求：长词必须在前，否则会被短词拆成残字——
 * '微电影' 先于 '电影'、'电视剧' 先于 '电视'、'动画片' 先于 '动画'、
 * '戏曲' 先于 '戏'、'广播剧' 先于 '广播'、'有声小说' 先于 '有声书'。
 * 拉丁字母项一律小写（匹配前会把文本 toLowerCase）。
 */
export const CONTENT_TYPE_WORDS: readonly string[] = [
  // 影视 / 视频
  '微电影', '电视剧', '电视', '电影', '动画片', '动画', '动漫', '漫剧', '纪录片', '综艺',
  '节目', '晚会', '春晚', '短片', 'mv',
  // 戏剧 / 曲艺（'戏说' 要在 '戏' 前，'戏曲' 同理）
  '话剧', '舞台剧', '音乐剧', '歌剧', '戏曲', '京剧', '越剧', '黄梅戏', '豫剧', '昆曲',
  '评剧', '川剧', '粤剧', '曲艺', '相声', '小品', '评书', '评话', '评说', '快板', '戏说', '戏',
  // 音频 / 口播
  '有声小说', '有声书', '小说', '广播剧', '广播', '电台', '故事', '童话', '主题曲',
  // 讲座 / 课程
  '讲座', '讲坛', '公开课', '课堂', '讲话', '演讲', '录播', '录影',
  // 赛事 / 直播 / 集锦 / 解说 / 影视域限定词（说票房的一定是在要电影，不是点歌）
  '比赛', '赛事', '集锦', '解说员', '解说', '评论员', '直播', '回放', '票房',
]

/** 用户是否在要评书/相声/电视剧这类非歌曲内容（用于选择「没找到」的措辞）。 */
export function isSpokenContentRequest(text?: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return CONTENT_TYPE_WORDS.some((w) => t.includes(w))
}

/** 判断一句话是否只是泛化点歌/语气（如「歌 / 放首歌 / 播放个音乐」），而非带具体歌手/歌名/风格。 */
export function isGenericPlayPhrase(text: string): boolean {
  const c = (text ?? '').replace(/\s/g, '')
  return c.length > 0 && GENERIC_PLAY_WORDS.test(c)
}

/** 把风格描述/歌名/内容类型收敛成搜索词；无匹配给空串（上层回落电台）。 */
export function genreToKeyword(genre?: string): string {
  if (!genre) return ''
  const trimmed = genre.trim()
  // 先按风格词映射（轻音乐/电子/爵士…），命中直接返回该风格词（明确的风格请求，非回落）
  for (const entry of GENRE_KEYWORDS) {
    if (entry.match.test(trimmed)) return entry.keyword
  }
  // 否则当具体歌名/歌手处理：去掉指令性填充词与“的”
  let kw = trimmed
  for (const word of COMMAND_WORDS) {
    kw = kw.split(word).join('')
  }
  // 「我想看 / 我看 / 你看 / 您看」这类口语前缀（用户真正要的是「看 TV/电影/动画」）：
  // 剥掉后只留内容词去检索，否则「我想看西游记」会变成带「想看」的垃圾检索词而搜不到。
  kw = kw.replace(/^(?:我(?:想|要)?看|你看|您看)\s*/, '')
  // 去掉「列出 / 念出 / 报 / 说」这类“列歌单、念名字”的指令动词：用户只是要歌名，
  // 不是换播放动词；不剔掉会把「列出周杰伦的歌」变成「列出…周杰伦」这种搜不到的垃圾词。
  // 用「动词 | 标点/空白 | 一?下/个」循环的重复，吃掉动词之间夹的顿号、以及「一下/一个」填充。
  kw = kw.replace(/^(?:列出|列|念出|念|报出?|说出来?|给我|让我|帮我|想|要|[、，。\s]|一?[下个])+/, '')
  // 去掉数量词：3首 / 三首 / 几首（用户要“列3首”，检索只需歌手名）。只在这些组合里清「首」，
  // 绝不全局删「首」——否则「来首歌 / 放首歌」会被拆坏、失去泛化回落轻音乐的兜底。
  kw = kw.replace(/\d+\s*首/g, '').replace(/[一二两三四五六七八九十]+\s*首/g, '').replace(/几\s*首/g, '')
  // 去掉「其它 / 其他 / 别的 / 另外」这类“要一首不同的”填充词：用户说「林俊杰其它的歌」
  // 是只想听林俊杰，不是点歌名带「其它」；留着会让候选检索与 B 站搜索都拿「林俊杰其它」搜不到。
  kw = kw.replace(/(其它|其他|别的|另外)/g, '')
  // 「作品」是泛称（「周星驰的作品」「放个作品」），不是作品名，剔掉后按人名检索。
  kw = kw.replace(/作品/g, ' ')
  kw = kw.replace(/的/g, ' ').replace(/\s+/g, ' ').trim()
  // 「周星驰演的电影」「成龙主演的电影」「张艺谋拍的电影」「张艺谋监制的电视剧」「周杰伦唱的歌」：
  // 主演/参演/出演/客串/导演/拍摄/执导/演唱/监制 是演员、导演或歌手的谓语，不是作品名的一部分；
  // 留着会让检索词变成「周星驰演 电影」「主演 电影」「周杰伦唱 歌」这种 B 站搜不到的组合。
  // 末尾单独的「演 / 拍 / 唱」同理（「周星驰拍 电影」→「周星驰 电影」），
  // 但「演员」这种名词不能剥。
  kw = kw.replace(/(主演|参演|出演|客串|导演|拍摄|执导|演唱|监制|制片|编剧)/g, ' ')
  kw = kw.replace(/(?:演|拍|唱)(?=\s|$)/g, ' ')
  kw = kw.replace(/\s+/g, ' ').trim()
  // 画质/音质修饰词（4K / 1080P / 高清 / 蓝光 …）是偏好，不是作品名。
  // 留在检索词里会让「4k 流浪地球」变成必须标题也写 4k 才命中，反而搜不到；
  // 排序侧在 bilibiliSearchSource 的 PREFER 里给它们加分，所以剔掉不会丢「优先 4K」的意图。
  // 拉丁字母词用 \b 限定，避免误伤含 hd/4k 的英文作品名（如 hdmi）。
  // 「精彩」是评价词不是内容名（「精彩集锦」「精彩比赛」），剔掉后按「集锦 / 比赛」检索。
  kw = kw.replace(/(精彩|高清|超清|蓝光|杜比视界|杜比全景声|杜比)/g, ' ')
  kw = kw.replace(/\b(?:4k|8k|1080p|720p|2160p|uhd|hdr|hd)\b/gi, ' ')
  kw = kw.replace(/\s+/g, ' ').trim()
  // 去掉开头可能残留的播放动词（「放 / 播 / 唱 / 听 / 看 / 演 / 拍」）：「放刘德华的歌」→「刘德华 歌」、
  // 「唱周杰伦的歌」→「周杰伦 歌」、「听周杰伦的歌」→「周杰伦 歌」，否则残留动词会让
  // 候选/检索词变成「放刘德华 / 唱周杰伦」，B 站与 MusicBrainz 都搜不到
  // （「播放刘德华的歌」能放正是因为它被 COMMAND_WORDS 的「播放」整词剔掉了）。
  // 「看 / 演 / 拍」用于电视、电影、动画片、漫剧这类内容（「看电影」「演个电影」「拍电影」→「电影」）；
  // 因为匹配是子串判断，剥掉动词不会让「看月亮爬上来」这类歌名失效。
  // 「演员」是名词，不能把「演」当动词剥掉。
  // 动词后允许跟「一/两/几 + 段/首/个/回/集」：「放段相声」→「相声」。
  kw = kw.replace(/^(?:[放播唱听看拍]|演(?!员))(?:[一两几])?[段首个回集]?\s*/, '')
  // 「来」只有在后面紧跟量词时才算播放动词（「来一段相声」「来段相声」）；
  // 否则可能是歌名开头（「来日方长」），不能剥。
  kw = kw.replace(/^来(?:[一两几][段首个回集]|[段首个回集])\s*/, '')
  // 剔除后只剩泛化词/语气词（或为空）→ 回落空串，由上层路由到轻音乐电台，别拿去白搜
  const compact = kw.replace(/\s+/g, '')
  if (!compact || GENERIC_PLAY_WORDS.test(compact)) return ''
  // 「播放个周杰伦的稻香」这类：指令词删掉后残留开头的量词「个/首/点」，去掉再搜。
  // 「段」用于评书/相声这类内容（「放段相声」→「相声」），否则会拿「段相声」白搜。
  const normalized = kw.replace(/^[个首点些段]+\s*/, '').trim()
  if (!normalized) return ''
  // 只说「戏」太泛（B 站搜「戏」会命中任何标题带「戏」的视频），统一收敛到「戏曲」再检索。
  return normalized === '戏' ? '戏曲' : normalized
}

/**
 * 判断用户的描述是否“风格/氛围”请求（轻音乐/电子/爵士…），而非具体歌名/歌手。
 * 聚合音乐源据此分流：风格走 SomaFM 电台，点歌走 B 站搜索兜底。
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
  // 推荐/列出类动词与修饰词：推荐意图走候选列表分支，这些词不是歌名/歌手，必须剔掉，
  // 否则「推荐周杰伦的歌」会收敛成「推荐周杰伦」拿去检索，「推荐几首歌」会拿「推荐歌」白搜。
  '推荐',
  '挑几首',
  '选几首',
  '找几首',
  '有什么',
  '有哪些',
  '来点好听',
  '好听',
  '好听的',
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
