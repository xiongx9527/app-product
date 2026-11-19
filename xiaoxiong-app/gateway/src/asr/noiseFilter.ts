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
// 语气词/咳嗽拟声（无语义）。「我/你」这类代词幻觉由 VAD 幻觉二级判断接管，不放这里堆字。
const FILLERS = new Set(['嗯', '啊', '哦', '呃', '额', '噢', '欸', '哎', '喂', '呀', '呢', '吧', '嘛', '唉', '嗝'])

/**
 * 咳嗽/清嗓/犹豫被 SenseVoice 误识别成的拟声字。这些字本身无语义，
 * 整段由它们构成（含叠用，如「嗯嗯」「咳咳」「嗯额」）就是噪声，不该触发一轮回答。
 * 注意：不在此列的实义叠字（「好好」「是是」「对对」）可能是真实简短应答，不拦。
 */
const COUGH_FILLER_CHARS = new Set(['嗯', '啊', '哦', '呃', '额', '噢', '欸', '哎', '咳', '呵', '嘶', '嘘', '嗽', '呼', '哈', '哼', '嗝'])

/** 整段是咳嗽/语气拟声字的叠用（「嗯嗯」「咳咳」「嗯额呃」）→ 噪声。 */
function isCoughFillerBurst(core: string): boolean {
  if (core.length < 2 || core.length > 6) return false
  return [...core].every((ch) => COUGH_FILLER_CHARS.has(ch))
}

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

/**
 * 中文会话下的「纯外文短句」幻觉：儿童说话 / 环境音被 SenseVoice 识别成英文词序列
 * （hello baby / oh my god / go go go…）。中文会话里用户不会用纯英文短句下指令（ASR 也
 * 不懂），整段纯拉丁 ≤6 词且不含中文/数字时按噪声丢弃。
 * 不误伤：中英混排（Taylor Swift 的歌）、英文歌名带中文前缀、纯数字选号、长英文句（>6 词）。
 */
export function isForeignNoise(text: string, lang: string): boolean {
  if (!lang.toLowerCase().startsWith('zh')) return false
  const t = text.trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false // 含中文 = 混排，放行
  if (/\d/.test(t)) return false // 含数字（选号 / 型号）放行
  const words = t.replace(/[^A-Za-z\s']/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return false
  return words.length <= 6
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
  // 单字：语气词/咳嗽拟声/「我」「你」当噪声；其余实义单字（滚/好/停/是/对/在/给）保留。
  // 「我」是真机打嗝被 SenseVoice 脑补出的高频单字（2026-11-18 实测 3 条：打嗝→「我。」）；
  // 「你」是百科播报刚结束时回声/短促噪声被脑补出的单字（实测 09:06:00 FINAL「你。」）。
  // 真人不可能只说一个「我/你」字当指令（都是「我要/我想/你放」等多字句），故仅单字判噪声，
  // 多字句里的「我/你」照常放行——与「逐字黑名单」误伤真人无关。
  // ZCR 声学门控（openai_voice_server.py）拦不住这类幻觉：短促浊音 ZCR≈0.086 与真人同区间。
  if (core.length === 1) return FILLERS.has(core) || COUGH_FILLER_CHARS.has(core)
  // 咳嗽/清嗓/犹豫的叠用拟声（「嗯嗯」「咳咳」「嗯额」）：整段无语义，判噪声。
  // 必须在单字之后、返回 false 之前；只吃拟声字集合，不影响「好好」「是是」等实义叠字。
  if (isCoughFillerBurst(core)) return true
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

/**
 * 去掉 SenseVoice 在句尾多吐出来的重复片段。
 *
 * 实机证据（2026-11-17）：用户说「今天天几怎么样？」，滚动重识别的第二段与定稿都变成
 * 「今天天气怎么样？天气。」——主体已经完整收在问号处，问号后面又多跟了一次「天气」。
 * 这不是「纠正词替换」追加的（本项目没有词表替换逻辑），SenseVoice 直接吐出的文本就这样。
 * 若原样下发，「我说」卡片和 LLM 都会看到结尾挂着一个多余的词。
 *
 * 判据（尽量保守，只删确定是重复尾巴的）：
 *  - 找到一个句末标点（。？！?!），其后仍有非空内容才算「尾巴」；无尾巴直接返回原文。
 *  - 尾巴去掉空白/标点后的核心 ≥2 字（单字不删，避免误伤「走吧？走」这类正常强调）。
 *  - 尾巴核心已在标点之前的主体里出现过（coreText 比对）→ 认定重复，删到标点为止。
 *  - 中英混排、无句末标点、尾巴是全新内容（不是重复）都保持原文。
 */
/**
 * 唤醒词 / 高频短指令词：重复段里含这些词时，是用户真实指令被 ASR 原样说了两遍，
 * 绝不能折叠——否则「小熊，小熊」被折成「小熊，」前端就匹配不到唤醒词，直接唤不醒。
 * 与前端 uni_app/src/core/wake/types.ts 的 DEFAULT_WAKE_WORDS 保持一致（网关是独立
 * bundle，无法 import 前端常量）。只列短词：长句重复（"我喜欢打乒乓球"×2）不含这些
 * 词，照常折叠。
 */
const PROTECTED_COMMAND_WORDS: readonly string[] = [
  // 唤醒词（"小熊"已覆盖 小熊小熊 / 小熊熊 / 小小熊）
  '小熊',
  // 高频短控制指令
  '播放', '暂停', '停止', '关闭', '开启', '打开', '取消', '确定', '继续',
  '下一首', '上一首', '下一集', '上一集', '搜索', '切换', '退出', '重播',
  '跳过', '音量', '字幕', '记一下', '清空',
]

/** 重复段是否含唤醒词/指令词——含则放过（不折叠），保护真实指令。 */
function containsCommandWord(core: string): boolean {
  return PROTECTED_COMMAND_WORDS.some((w) => core.includes(w))
}

/**
 * 折叠「A+A」式整词组重复（SenseVoice 句尾重复的另一形态，无标点）。
 * 实机：朗诵滕王阁序 → "朗诵滕王阁序滕王阁序"（"滕王阁序"重复两遍），导致作品名查不到。
 * 只处理完全一致的重复段（每段≥2字），保守避免误伤正常表达（如"追追追""走走停停"）。
 */
function collapseRepeatedPhrase(text: string): string {
  const trimmed = text.trim()
  const core = trimmed.replace(/[。．.！!？?，,、\s]+$/u, '')
  // 整句连说两遍（用户把一句话说了两遍，ASR 原样输出）：无标点 A+A，每段≥4字才折叠。
  // "我喜欢打乒乓球我喜欢打乒乓球"→"我喜欢打乒乓球"。每段≥4字保证不碰唤醒词
  // 「小熊小熊」(2字)、「搜索搜索」「取消取消」(2字)、「走走停停」(非A+A) 等真实输入。
  const n = core.length
  // 整句 A+A 折叠；含唤醒词/指令词的重复放过（如用户连喊多声唤醒词），保护真实指令。
  if (n >= 8 && n % 2 === 0 && core.slice(0, n / 2) === core.slice(n / 2) && !containsCommandWord(core)) {
    return core.slice(0, n / 2) + trimmed.slice(core.length)
  }
  // 只在带朗读动词时折叠：诗词/古文重复（"朗诵滕王阁序滕王阁序"）总带"朗诵/背诵"。
  // 绝不能对纯"A+A"折叠——"小熊小熊"(唤醒词)、"搜索搜索"、"取消取消"都是真实用户输入，
  // 折叠会破坏唤醒词（实测导致 asr.queued 收不到"小熊小熊"、唤醒失效）。
  const verb = /^(朗诵一下|背诵一下|念一下|读一下|朗诵|背诵|念|读|吟)/u.exec(core)
  if (!verb) return text
  const rest = core.slice(verb[0].length)
  if (rest.length >= 4 && rest.length % 2 === 0 && rest.slice(0, rest.length / 2) === rest.slice(rest.length / 2)) {
    const tail = text.trim().slice(core.length)
    return verb[0] + rest.slice(0, rest.length / 2) + tail
  }
  return text
}

/**
 * 折叠「用标点隔开的相邻重复句」：用户把一句话说了两遍，ASR 原样输出
 * （"人太多了，人太多了。"→"人太多了。"、"昨天，昨天发生了什么"→"昨天发生了什么"）。
 * 只在相邻片段「去掉标点后完全相同」时去重，不碰字级叠字/唤醒词/真实 A+A 表达。
 */
function collapseRepeatedClauses(text: string): string {
  // 按句末/逗号切分，保留分隔符。每段去空白后比较核心（再去掉尾部标点）
  const parts = text.split(/([，,。．.！!？?、\s]+)/)
  // parts 偶数下标是文字段、奇数下标是分隔符段
  const out: string[] = []
  let prevCore = ''
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i] ?? ''
    const sep = parts[i + 1] ?? ''
    const core = seg.replace(/^[，,。．.！!？?、\s]+|[，,。．.！!？?、\s]+$/g, '')
    // 相邻文字段核心完全相同、且≥2字（仅排除单字重复如"好。好"，不是靠字数判断是不是
    // 唤醒词）才折叠；重复段含唤醒词/指令词时是用户真实指令说两遍，放过不折叠——
    // 「小熊，小熊」折成「小熊，」会让前端匹配不到唤醒词（真机唤不醒）。
    // "人太多了，人太多了"不含指令词，正常折叠。
    if (core.length >= 2 && core === prevCore && !containsCommandWord(core)) {
      // 相邻文字段核心完全相同：跳过这一段（含其后的分隔符），保留前一段的分隔符
      continue
    }
    out.push(seg, sep)
    if (core) prevCore = core
  }
  const result = out.join('')
  return result || text
}

export function stripTrailingEcho(text: string): string {
  if (!text) return text
  // ① 折叠无标点的整词组重复（"滕王阁序滕王阁序"）② 折叠标点隔开的重复句（"人太多了，人太多了"）
  const collapsedPhrase = collapseRepeatedPhrase(text)
  if (collapsedPhrase !== text) return collapsedPhrase
  const collapsedClauses = collapseRepeatedClauses(text)
  if (collapsedClauses !== text) return collapsedClauses
  // SenseVoice 习惯给整句补一个收尾句号（「…天气。」）。先把这个收尾标点摘掉再分析，
  // 否则「最后一个标点」会落到收尾句号上、尾巴变空，永远删不掉重复词。
  const trimmed = text.trim().replace(/[。．.！!？?，,、\s]+$/u, '')
  // 切点 = 剩下文本里最后一个句末标点；它之后到末尾就是「尾巴」（重复词）
  const matches = [...trimmed.matchAll(/[。？！?!]/g)]
  if (matches.length === 0) return text
  const cut = (matches[matches.length - 1].index ?? 0) + 1
  const body = trimmed.slice(0, cut)
  const tailCore = coreText(trimmed.slice(cut))
  if (tailCore.length < 2) return text // 单字/空尾巴不删（避免误伤「走吧？走」）
  const bodyCore = coreText(body)
  if (!bodyCore || bodyCore.length < tailCore.length) return text
  // 尾巴核心在主体里出现过才是「重复」，否则是正常补充（如「去北京？上海也行」）
  if (!bodyCore.includes(tailCore)) return text
  return body
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
