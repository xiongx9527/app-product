/**
 * 点歌信息不足时的「候选歌曲列表」：用户只说了歌手（周杰伦）或只说了歌名（稻香），
 * 无法唯一定位一首，就用 MusicBrainz 免费接口检索出「歌名+歌手」候选，口播编号列表，
 * 让用户用语音说「第几首」或直接说歌名来选。选中的那首再拼成「歌手+歌名」
 * 交给聚合播放源（B 站）抽音轨，天然接上「歌手、歌名要一样」的严格匹配。
 */

export interface MusicCandidate {
  title: string
  artist: string
}

interface MusicBrainzRecording {
  title?: string
  'artist-credit'?: Array<{ name?: string }>
}

/** 可注入的检索器：单测用桩，避免真实联网。 */
export type CandidateFetcher = (
  url: string
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const MB_ENDPOINT = 'https://musicbrainz.org/ws/2/recording'
// 候选列表上限：语音口播「第1首…第N首」太长用户记不住，且 MusicBrainz 越靠后的结果越不准，
// 最多给 3 首让用户选，既够挑又不啰嗦。
const MAX_CANDIDATES = 3

const defaultFetcher: CandidateFetcher = (url) =>
  fetch(url, {
    // MusicBrainz 要求带可识别的 User-Agent，否则 403；加超时避免检索服务卡住会话
    headers: { 'User-Agent': 'app-product-voice-assistant/0.1 (local voice assistant)' },
    signal: AbortSignal.timeout(6000),
  }) as unknown as ReturnType<CandidateFetcher>

/**
 * 用歌手名或歌名检索候选歌曲。返回至多 5 条「歌名+歌手」；失败/无结果返回空数组，
 * 由调用方决定是否回退到直接解析（不因检索服务不可用而卡住播放）。
 */
export async function searchCandidates(
  query: string,
  fetcher: CandidateFetcher = defaultFetcher
): Promise<MusicCandidate[]> {
  const q = encodeURIComponent(query.trim())
  if (!q) return []
  try {
    const res = await fetcher(`${MB_ENDPOINT}?query=${q}&fmt=json&limit=${MAX_CANDIDATES}`)
    if (!res.ok) return []
    const data = (await res.json()) as { recordings?: MusicBrainzRecording[] }
    return (data.recordings ?? [])
      .map((r) => ({
        title: (r.title ?? '').trim(),
        artist: (r['artist-credit']?.[0]?.name ?? '').trim(),
      }))
      .filter((c) => c.title.length > 0)
      .slice(0, MAX_CANDIDATES)
  } catch {
    return []
  }
}

/** 「的歌 / 歌曲 / 音乐」这类通用尾词，不算点歌信息，判断信息量时要剔除。 */
const GENERIC_MUSIC_WORDS = new Set([
  '歌', '歌曲', '音乐', '乐曲', '曲', '曲子', '曲目', '首歌',
  '点歌', '听歌', '放歌', '唱歌', '一首', '一些', '几首', '推荐',
])

/** 剔除通用音乐词后的实词。如「周杰伦 歌」→ ['周杰伦']，「周杰伦 稻香」→ ['周杰伦','稻香']。 */
function contentWords(keyword: string): string[] {
  return keyword
    .trim()
    .split(/\s+/)
    .filter((t) => t && !GENERIC_MUSIC_WORDS.has(t))
}

/**
 * 是否信息不足、需要给候选列表让用户选：去掉通用音乐词后只剩一个实词
 * （只说了歌手「周杰伦」、或只说了歌名「稻香」、或「周杰伦的歌」）。
 * 「周杰伦 稻香」这类两个实词视为已指定歌手+歌名，直接播。
 */
export function needsCandidateList(keyword: string): boolean {
  return contentWords(keyword).length <= 1 && contentWords(keyword).length > 0
}

/** 检索用的核心词（去掉通用音乐词）：「周杰伦 歌」→「周杰伦」。 */
export function candidateQuery(keyword: string): string {
  return contentWords(keyword).join(' ')
}

/** 疑问/指令/招呼/闲聊：这些不该被当成「光报了个歌手/歌名」，交给 LLM 正常应答。 */
const NON_NAME_RE =
  /[谁什么怎为哪几多少吗呢吧啊呀么]|打开|关闭|设置|查询|帮我|告诉|介绍|讲|算|几点|天气|新闻|时间|日期|设个|定个|你好|您好|谢谢|在吗|在的|在不在|你是谁|你是谁呀|谁呀|嗨|嘿|喂|好的|行|可以|没事|哈哈|嗯|哦|诶|哎|干嘛|干啥/

/**
 * 是否像「只报了一个歌手/歌名」（没有播放动词也能给列表，如「周杰伦」「稻香」）。
 * 保守判定：短、纯名字字符、不含疑问词/常见指令动词。看起来是普通问句/指令就返回 false，
 * 交给 LLM 正常应答，避免把闲聊或设备命令劫持成点歌。
 */
export function looksLikeBareMusicQuery(text: string): boolean {
  const t = text.trim()
  if (t.length < 2 || t.length > 8) return false
  if (!/^[一-龥A-Za-z0-9·\s]+$/.test(t)) return false
  if (NON_NAME_RE.test(t)) return false
  return true
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/** 归一化：去空白与标点，便于比对歌名/序号。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 把用户下一句话解析成候选列表里的选择，返回 0-based 索引；不是选择返回 null。
 * 支持「第一首 / 第二个 / 2 / 就第3首」等序号，以及直接说歌名（如「就听晴天」）。
 * 注意：「再来一首 / 换一首」里的「一」是量词不是序号，必须排除，否则会被误判成选第 1 首。
 */
export function parseSelection(text: string, candidates: readonly MusicCandidate[]): number | null {
  if (!candidates.length) return null
  const norm = normalize(text)
  if (!norm) return null

  // 1) 显式序号：「第X首/个」，或整句就是个数字/中文数字（二、2、两）
  const ordinal = /第([一二两三四五六七八九十\d]+)[首个]?/.exec(norm)
  if (ordinal) {
    const num = toNumber(ordinal[1])
    if (num !== null && num >= 1 && num <= candidates.length) return num - 1
  }
  const bare = /^([一二两三四五六七八九十\d]+)[首个]?$/.exec(norm)
  if (bare) {
    const num = toNumber(bare[1])
    if (num !== null && num >= 1 && num <= candidates.length) return num - 1
  }

  // 2) 直接说歌名：候选标题出现在话语里
  for (let i = 0; i < candidates.length; i += 1) {
    const title = normalize(candidates[i].title)
    if (title && norm.includes(title)) return i
  }
  return null
}

function toNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  return CN_NUM[raw] ?? null
}
