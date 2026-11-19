/**
 * 通用自动学习引擎：助手从"系统以为 A、实际是 B"的偏差里自动积累知识。
 *
 * 设计成可插拔规则链——"自动学习"是个大概念，纠错（同音听错字）只是第一条规则：
 *   - 将来别的业务（新词、偏好、简称↔全称……）只需 register 一条新规则，
 *     不用改工具/LLM/识别层这些调用方，也不用改引擎。
 *   - 每条规则自己判断"这个 (from, to, context) 归不归我管"，命中才学习。
 *
 * 调用方统一：`engine.learn(from, to, context)`。fire-and-forget，绝不影响主流程。
 */

export interface AutoLearnContext {
  /** 学习信号来源：asr（识别层）/ tool（工具数据源）/ llm（大模型回复）/ 其它业务自定义 */
  source?: string
  /** 工具名等附加信息，规则可按需取用 */
  [key: string]: unknown
}

export interface AutoLearnRule {
  /** 规则名（日志/调试用） */
  name: string
  /** 判断并处理一条偏差。返回 true 表示这条规则消费了它（停止往后传）。 */
  handle: (from: string, to: string, ctx: AutoLearnContext) => Promise<boolean>
}

/** 学习命中的日志回调：带来源与命中的规则名，用于区分「工具学习 / LLM 学习 / 直连学习」。 */
export type AutoLearnLogger = (from: string, to: string, ctx: AutoLearnContext, ruleName: string) => void

export interface AutoLearnEngine {
  /** 注册一条学习规则（先注册的优先命中）。 */
  register: (rule: AutoLearnRule) => void
  /** 统一入口：给定确切的 (from, to)，依次问每条规则，命中即止。 */
  learn: (from: string, to: string, ctx?: AutoLearnContext) => Promise<boolean>
  /** 从两段文本各提取中文词做同音比对学习（工具入参/返回、LLM 识别原文/回复共用）。
   *  一次调用最多学一条，避免误学扩散。 */
  learnFromTexts: (wrongText: string, correctText: string, ctx?: AutoLearnContext) => Promise<boolean>
  /** 从识别原文取用户词、从回答/返回里按锚点（《》/播放：）取规范词再学。
   *  比 learnFromTexts 的滑动窗口更准，工具返回与 LLM 回复都走这条。 */
  learnFromAnchors: (fromText: string, toText: string, ctx?: AutoLearnContext) => Promise<boolean>
}

/**
 * 发音归一化规则表（可扩展）：每条把拼音里"听感相同/相近、ASR 常混"的音归到同一表示。
 * 将来要加新发音混淆（前后鼻音 in/ing、边音鼻音 n/l、卷舌 r/l 等），只需往这里加一项
 * {name, apply}，同音判定的行为自动跟随，不用改规则主逻辑。
 */
export interface PronNormalizer {
  name: string
  apply: (pinyin: string) => string
}
export const PRON_NORMALIZERS: PronNormalizer[] = [
  // 平翘舌：SenseVoice 高频把翘舌识成平舌（是→四、山→三、世→事、存→cun 无影响）
  { name: '平翘舌 zh/z,ch/c,sh/s', apply: (p) => p.replace(/\bzh/g, 'z').replace(/\bch/g, 'c').replace(/\bsh/g, 's') },
]

/** 依次套用所有发音归一化规则。 */
export function normalizePronunciation(pinyin: string): string {
  return PRON_NORMALIZERS.reduce((p, r) => r.apply(p), pinyin)
}

const wcClean = (s: string) => s.replace(/^[，,。.、"'“”‘’\s]+|[，,。.、"'“”‘’\s]+$/g, '').trim()
const wcIsWord = (s: string) => /^[\u4e00-\u9fff]{2,8}$/.test(s)

/**
 * 从文本按明确锚点提取"规范词"：书名号《》/「」、播放冒号、百科"名："。
 * 不用滑动窗口切全文——那会把"背诵《洛神赋》"的"背"当正确词（实测误学）。
 * 工具返回、LLM 回复都用它。
 */
export function extractAnchoredWords(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.match(/[《「]([\u4e00-\u9fff]{2,8})[》」]/g) ?? []) {
    const w = wcClean(m.slice(1, -1))
    if (wcIsWord(w)) out.add(w)
  }
  for (const m of text.match(/(?:正在为你播放|播放|Now playing)[:：]\s*([\u4e00-\u9fff]{2,8})/g) ?? []) {
    const w = wcClean(m.replace(/^(?:正在为你播放|播放|Now playing)[:：]\s*/, ''))
    if (wcIsWord(w)) out.add(w)
  }
  const colon = text.match(/^([\u4e00-\u9fff]{2,8})[：:]/)
  if (colon && wcIsWord(colon[1])) out.add(colon[1])
  return [...out]
}

/** 两串的最长公共子串长度（用于数据源纠错规则判断"是否同一个词的不同写法"）。 */
export function longestSharedSubstring(a: string, b: string): number {
  let best = 0
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1
      if (k > best) best = k
    }
  }
  return best
}

const STOP = new Set(['好的', '用户', '助手', '小熊', '播放', '正在', '为你', '为你播放', '没有', '找到', '可以', '什么', '这个', '那个', '一下', '现在', '今天', '明天', '昨天', '背若', '背洛'])
/**
 * 提取文本里的中文词候选：对每段连续中文做 2–4 字滑动窗口（覆盖大多数专有名词长度），
 * 这样"背若神父"能拆出"若神父"，不会因为整段连在一起而漏掉。规则会进一步筛同音。
 */
export function extractChineseWords(s: string): string[] {
  const out = new Set<string>()
  for (const seg of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let len = 2; len <= Math.min(4, seg.length); len += 1) {
      for (let i = 0; i + len <= seg.length; i += 1) {
        const w = seg.slice(i, i + len)
        if (!STOP.has(w)) out.add(w)
      }
    }
  }
  return [...out]
}

export function createAutoLearnEngine(logger?: AutoLearnLogger): AutoLearnEngine {
  const rules: AutoLearnRule[] = []
  return {
    register(rule) {
      rules.push(rule)
    },
    async learn(from, to, ctx = {}) {
      for (const rule of rules) {
        try {
          if (await rule.handle(from, to, ctx)) {
            logger?.(from, to, ctx, rule.name) // 命中即记来源，便于区分 tool/llm/直连
            return true
          }
        } catch {
          // 单条规则失败不影响其它规则和主流程
          continue
        }
      }
      return false
    },
    async learnFromTexts(wrongText, correctText, ctx = {}) {
      // 长词优先：ASR 文本常被切成片段（"被洛神父"→"洛神父"/"神父"），若短词先学，
      // 会学到"神父→神赋"这种子串错对。按长度降序让完整词（洛神父→洛神赋）先命中。
      const wrongs = extractChineseWords(wrongText ?? '').sort((a, b) => b.length - a.length)
      const corrects = extractChineseWords(correctText ?? '').sort((a, b) => b.length - a.length)
      for (const w of wrongs) {
        if (!w) continue
        for (const c of corrects) {
          if (!c || c === w) continue
          // 真正的同音判断交给已注册规则；学到一条即返回（一次调用最多学一条）。
          // 长词已排在前面，所以先命中的是完整词而非它的子串。
          if (await this.learn(w, c, ctx)) return true
        }
      }
      return false
    },
    async learnFromAnchors(fromText, toText, ctx = {}) {
      // from：识别原文里按标点切出的连续中文段，取 2–8 字整段 + 其 2–4 字滑窗
      // （"李存旭的百科"→整段过长，滑窗能切出"李存旭"）。
      const froms = new Set<string>()
      for (const seg of (fromText ?? '').match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
        if (wcIsWord(seg)) froms.add(seg)
        for (let len = 2; len <= Math.min(4, seg.length); len += 1) {
          for (let i = 0; i + len <= seg.length; i += 1) {
            const w = seg.slice(i, i + len)
            if (wcIsWord(w) && !STOP.has(w)) froms.add(w)
          }
        }
      }
      // to：锚点提取（《》/播放：）优先，再补 LLM 回复里的词（长词优先）
      const tos = [
        ...extractAnchoredWords(toText ?? ''),
        ...extractChineseWords(toText ?? '').sort((a, b) => b.length - a.length),
      ]
      for (const f of [...froms].sort((a, b) => b.length - a.length)) {
        for (const t of tos) {
          if (t === f) continue
          if (await this.learn(f, t, { ...ctx, anchored: true })) return true
        }
      }
      return false
    },
  }
}
