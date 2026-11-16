/**
 * ASR 后处理：过滤「环境杂音被误识别成一句话」的伪文本。
 *
 * 本地 SenseVoice / Whisper 对非语音音频（键盘、风扇、扬声器回声、静音段）
 * 会稳定地产出短促幻觉文本。这些文本一旦进 LLM，就会凭空多出一轮回答和
 * TTS，听起来就是助手在自言自语。所以在定稿后、进模型前统一拦一层。
 *
 * 只拦「极短 + 明确非语义」的片段；正常的短问句（如「滚。」）必须放行。
 */

/** Whisper/SenseVoice 常见的整段幻觉输出（归一化后精确匹配）。 */
const HALLUCINATIONS = new Set([
  'yeah', 'yes', 'no', 'ok', 'okay', 'uh', 'um', 'hmm', 'mm', 'huh',
  // 冠词 / 常见的英文幻觉碎片：SenseVoice 对音乐回声、静音段会稳定冒出这些词，
  // 中文会话里单独出现几乎必为噪声（「The」「Yeah」是用户实机高频复现的两个）。
  'the', 'a', 'an', 'oh', 'well', 'so',
  'thanks', 'thankyou', 'bye', 'hello', 'hi',
  '字幕', '谢谢观看', '请不吝点赞', '订阅', '转发', '打赏', '点点关注',
  'music', 'applause', 'silence',
])

/** 单个语气词：单独出现时几乎都是噪声，不值得触发一轮回答。 */
const FILLERS = new Set(['嗯', '啊', '哦', '呃', '额', '噢', '欸', '喂', '呀', '呢', '吧', '嘛', '唉'])

/** 去掉空白、标点、符号、emoji 后剩下的「有效内容」。 */
function coreText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 16bit PCM 的均方根幅度。上行 16k、下行 24k 的幅度量纲一致，可直接比大小，
 * 用来判断麦克风收到的这一帧是不是「扬声器收回来的自己」。
 */
export function pcmRms(frame: Uint8Array): number {
  const samples = Math.floor(frame.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const value = view.getInt16(i * 2, true) / 32768
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}

/**
 * 极短的纯拉丁字母虚词/填充词（可 1–3 个词）：SenseVoice 对静音段、音乐/提示音回声
 * 会稳定冒出这类碎片（The / Yeah / oh yeah / the one 等），任何会话语言下都不是有效指令。
 * 只在「整段都是拉丁虚词」时命中：含中文、含数字、或带实义词的短句都放行，
 * 避免误伤中英混排（Taylor Swift 的歌）和英文用户的正常短指令。
 */
const EN_FILLER_WORDS = new Set([
  'the', 'a', 'an', 'yeah', 'yes', 'no', 'ok', 'okay', 'oh', 'uh', 'um',
  'hmm', 'mm', 'huh', 'well', 'so', 'um', 'er', 'ah', 'hey', 'wow',
  'music', 'applause', 'silence', 'thanks', 'thank', 'you', 'please',
  // 代词/系动词/介词连词等高频虚词：中文会话里 SenseVoice 对回声/静音段稳定冒出的
  // 纯英文碎片还包括 she / he / it / is 等单独词（用户 2026-11-16 实测反馈）。
  // 保持「整段全是虚词」边界：含实义词（歌名/人名）或中文/数字的短句都不在此拦。
  'she', 'he', 'it', 'they', 'them', 'him', 'her', 'his', 'its', 'we', 'us',
  'me', 'my', 'our', 'i', 'this', 'that', 'these', 'those', 'there', 'here',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'shall', 'and', 'but', 'or', 'nor', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'up', 'down', 'out', 'off', 'again',
  'then', 'now', 'just', 'still', 'even', 'ever', 'very', 'too', 'also',
])

function isShortEnglishFragment(text: string): boolean {
  // 去标点但保留词间空白，才能把 "oh yeah" 分成两个词（coreText 会把空格也去掉）
  const norm = text.replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!norm) return false
  // 必须整段都是拉丁字母词，含中文/数字/其它脚本一律不在此拦
  if (!/^[a-z]+(?: [a-z]+)*$/.test(norm)) return false
  const words = norm.split(/\s+/)
  // 超过 3 个词不再是「碎片」，交给 LLM 判断（如 "play the beatles song" 可能是真实请求）
  if (words.length === 0 || words.length > 3) return false
  return words.every((w) => EN_FILLER_WORDS.has(w))
}

export function isNoise(text: string): boolean {
  const core = coreText(text)
  if (!core) return true
  if (HALLUCINATIONS.has(core.toLowerCase())) return true
  if (isShortEnglishFragment(text)) return true
  // 单个拉丁字母（H / E / B…）：ASR 对静音/回声的字母级幻觉，任何语言下都不是有效指令
  //（英文有效词至少两个字母；用户 2026-11-16 实测高频复现「H.」）。
  if (core.length === 1 && /[a-z]/i.test(core)) return true
  // 极短纯假名（はい / うん…）：中文/英文会话里冒出的日语碎片同样是静音/回声幻觉
  //（用户实测「はい.」被当成用户说话触发了一轮回答）。
  if (core.length <= 4 && /^[\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(core)) return true
  // 单字：只有语气词当噪声，实义单字（如「滚」「好」）保留
  if (core.length === 1) return FILLERS.has(core)
  return false
}

/** 语言 → 该语言必须出现的 Unicode 脚本。 */
const LANGUAGE_SCRIPTS: Record<string, RegExp> = {
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  en: /\p{Script=Latin}/u,
}

/**
 * 只接收当前语言对应的文字：中文会话里蹦出的纯英文/数字/符号，
 * 基本都是噪声或回声，不该当成用户说话。命中不了脚本就返回 false，
 * 由调用方提示用户去设置里切换语言。
 */
export function matchesLanguage(text: string, lang: string): boolean {
  const core = coreText(text)
  if (!core) return false
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  const script = LANGUAGE_SCRIPTS[prefix]
  // 未登记的语言不拦截，避免把正常内容误丢
  if (!script) return true
  return script.test(core)
}

/**
 * 回声判定：播报期间麦克风收回自己的声音，ASR 会把它转成一句「用户说话」。
 * 网关握有刚送进 TTS 的原文，用字符重合度把这类结果拦掉。
 * 只判「高度雷同」：用户真的在插话时文本不同，不会被误杀。
 */
export function resemblesSpoken(text: string, spoken: readonly string[]): boolean {
  const candidate = normalize(text)
  if (candidate.length < 2) return false
  return spoken.some((line) => {
    const target = normalize(line)
    if (target.length < 2) return false
    if (target.includes(candidate) || candidate.includes(target)) return true
    return bigramOverlap(candidate, target) >= 0.75
  })
}

function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/** 二元组重合率，容忍 ASR 把个别字听错。 */
function bigramOverlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let hit = 0
  ga.forEach((g) => {
    if (gb.has(g)) hit += 1
  })
  return hit / Math.min(ga.size, gb.size)
}
