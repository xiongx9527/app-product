/**
 * 推理模型（gpt-oss 的 Harmony / 混元等）会把一次回答拆成多个「channel」：
 *   <|start|>assistant<|channel|>analysis<|message|>   ← 思考过程（英文/推理）
 *   <|start|>assistant<|channel|>final<|message|>      ← 最终答案（用户可见、需朗读）
 *   <|start|>assistant to=functions.x<|channel|>commentary<|message|> ← 工具调用
 *   <|end|> / <|return|>                              ← 结束
 * 模型的 OpenAI 兼容层可能不解析这套格式，把上述控制符连同思考正文当作普通文本流下发
 * （TEXT_BLOCK_DELTA），于是原始 token 与英文推理泄漏到用户可见文本，甚至被 TTS 念出来。
 *
 * 这里在网关把完整 header 识别出来：思考/工具 channel 走 onThinking（界面思考区，不进 TTS、
 * 不作正式回答），final 及未标记的正文走 onDelta。任何残存控制符都被剥离，绝不下发到用户侧，
 * 无论模型换不换、格式变不变都兜底。
 */

/**
 * 完整 Harmony header：从 <|start|> 到 <|message|>，捕获其间的 channel 名。
 * header 里会夹杂 assistant / to=收件人 / commentary / <|constrain|>json 等片段，
 * 用惰性的任意字符把这些片段连同控制符整体消费掉，避免它们泄漏成正文。
 */
const HEADER = /<\|start\|>[\s\S]*?<\|channel\|>([a-zA-Z_]+)[\s\S]*?<\|message\|>/
/** 结束标记（可能有 <|end|> / <|return|> / <|call|> 等） */
const CHANNEL_END = /<\|(?:end|return|call)\|>/
/** 任何残留的控制符（兜底剥离，绝不下发）：形如 <|xxx|> */
const RESIDUAL_TOKEN = /<\|[^|]*\|>/g

/** 这些 channel 不是给用户看的：思考过程与工具调用，只进思考区、不进 TTS、不作回答。 */
const HIDDEN_CHANNELS = new Set([
  'analysis',
  'thinking',
  'reasoning',
  'thought',
  'commentary',
])

export interface ChannelSink {
  (text: string): void
}

/**
 * 流式把文本增量喂进来，按 channel 拆分后分别回调。
 * 增量可能从任意位置截断（header 被拆到多个 chunk），因此缓冲到能判定完整 header 才下发，
 * 且永远不会把不完整的 header 前缀当成正文下发到用户侧。
 */
export class ChannelSplitter {
  private buf = ''
  /** 当前所处 channel 是否「隐藏」（思考/工具）；null = 尚未见到 header，按可见正文处理。 */
  private hidden: boolean | null = null

  constructor(
    private readonly emitDelta: ChannelSink,
    private readonly emitThinking: ChannelSink
  ) {}

  push(text: string): void {
    this.buf += text
    this.drain()
  }

  /** 流结束：下发剩余正文，先剥离完整控制符，再丢弃末尾未闭合的 header 残片。 */
  end(): void {
    let cleaned = this.buf.replace(CHANNEL_END, '').replace(RESIDUAL_TOKEN, '')
    // 末尾若仍是未闭合的 header 残片（以 <| 开头、没到 |>），直接丢弃；
    // 正常正文不会以 <| 残片收尾，这里只兜底截断的标记。
    const i = cleaned.lastIndexOf('<|')
    if (i !== -1) cleaned = cleaned.slice(0, i)
    this.flush(cleaned)
    this.buf = ''
    this.hidden = null
  }

  /** 反复抽取完整 header，把 header 之间的内容按「上一个 channel」归类下发。 */
  private drain(): void {
    for (;;) {
      const m = HEADER.exec(this.buf)
      if (!m) {
        // 没有完整 header：末尾可能是被截断的 header 起点，留到下次或 end()。
        this.flushSafePrefix()
        return
      }
      const before = this.buf.slice(0, m.index)
      this.flush(before)
      this.hidden = HIDDEN_CHANNELS.has(m[1].toLowerCase())
      this.buf = this.buf.slice(m.index + m[0].length)
      HEADER.lastIndex = 0
    }
  }

  /**
   * 没有完整 header 时，按优先级保留可能跨 chunk 截断的 header、只下发安全前缀：
   *  1) 存在 <|start|>：其之前的正文安全，之后（含残缺 header）整体保留到下次/end；
   *  2) 没有完整 <|start|> 但末尾有 <|：那是不成形的新 header 残片（被截断在 <|start|> 之前），保留；
   *  3) 都没有：buf 是不带标记的纯正文，全部下发。
   * 普通正文不含 <|start|> 与 <|，不影响正常内容。
   */
  private flushSafePrefix(): void {
    const startIdx = this.buf.lastIndexOf('<|start|>')
    if (startIdx !== -1) {
      this.flush(this.buf.slice(0, startIdx))
      this.buf = this.buf.slice(startIdx)
      return
    }
    const ltIdx = this.buf.lastIndexOf('<|')
    if (ltIdx !== -1) {
      this.flush(this.buf.slice(0, ltIdx))
      this.buf = this.buf.slice(ltIdx)
      return
    }
    this.flush(this.buf)
    this.buf = ''
  }

  private flush(text: string): void {
    if (!text) return
    const clean = text.replace(RESIDUAL_TOKEN, '')
    if (!clean) return
    if (this.hidden === true) this.emitThinking(clean)
    else this.emitDelta(clean)
  }
}
