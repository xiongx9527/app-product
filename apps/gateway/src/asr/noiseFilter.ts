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

export function isNoise(text: string): boolean {
  const core = coreText(text)
  if (!core) return true
  if (HALLUCINATIONS.has(core.toLowerCase())) return true
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
