/**
 * 推理模型（如 Hunyuan）把一次回答拆成多个「channel」：
 *   <|start|>assistant<|channel|>analysis<|message|>  ← 思考过程
 *   <|start|>assistant<|channel|>final<|message|>     ← 最终答案
 *   <|end|>                                           ← 结束
 * AgentScope 的 Ollama / OpenAI 兼容实现会把上述控制符连同思考正文当作普通文本流下发，
 * 于是思考内容和控制符泄漏到用户可见文本，甚至被 TTS 念出来（截图里的「…analysis…」即此）。
 *
 * 这里在网关把 channel 拆开：思考类 channel 走 onThinking（界面思考区，不进 TTS），
 * 其余（final / 未标记的正文）走 onDelta（正式回答）。同时保证任何残存的控制符都不会
 * 下发到用户侧——无论模型换不换、格式变不变都兜底。
 */

/** channel 起始标记：捕获 channel 名（analysis / final / …） */
const CHANNEL_START = /<\|start\|>assistant<\|channel\|>([a-zA-Z_]+)<\|message\|>/
/** 结束标记 */
const CHANNEL_END = /<\|end\|>/
/** 任何残留的控制符（兜底剥离，绝不下发） */
const RESIDUAL_TOKEN = /<\|[^|]*\|>/g

/** 哪些 channel 属于「思考过程」，不进入正式回答、不进 TTS。 */
const THINKING_CHANNELS = new Set(['analysis', 'thinking', 'reasoning', 'thought'])

export interface ChannelSink {
  (text: string): void
}

/**
 * 流式把文本增量喂进来，按 channel 拆分后分别回调。
 * 增量可能从任意位置截断（标记被拆到两个 chunk），因此内部缓冲到能判定完整标记才下发，
 * 且永远不会把不完整的标记前缀下发到用户侧。
 */
export class ChannelSplitter {
  private buf = ''
  private channel: string | null = null

  constructor(
    private readonly emitDelta: ChannelSink,
    private readonly emitThinking: ChannelSink
  ) {}

  push(text: string): void {
    this.buf += text
    this.drain()
  }

  /** 流结束：下发剩余正文，先剥离完整控制符，再丢弃末尾未闭合的标记残片。 */
  end(): void {
    let cleaned = this.buf.replace(CHANNEL_END, '').replace(RESIDUAL_TOKEN, '')
    // 末尾若仍是未闭合的标记残片（以 <| 开头、没到 |>），直接丢弃；
    // 正常正文不会以 <| 残片收尾，这里只兜底截断的标记。
    const i = cleaned.lastIndexOf('<|')
    if (i !== -1) cleaned = cleaned.slice(0, i)
    this.flush(cleaned)
    this.buf = ''
    this.channel = null
  }

  /** 反复抽取完整 channel 起始标记，把标记之间的内容按「上一个 channel」归类下发。 */
  private drain(): void {
    for (;;) {
      const m = CHANNEL_START.exec(this.buf)
      if (!m) {
        // 没有完整标记：末尾可能是一个被截断的标记起点，留到下次或 end()。
        this.flushSafePrefix()
        return
      }
      const before = this.buf.slice(0, m.index)
      this.flush(before)
      this.channel = m[1].toLowerCase()
      this.buf = this.buf.slice(m.index + m[0].length)
      CHANNEL_START.lastIndex = 0
    }
  }

  /**
   * 没有完整标记时，按优先级保留可能跨 chunk 截断的标记、只下发安全前缀：
   *  1) 存在 <|start|>：其之前的正文安全，之后（含残缺标记）整体保留到下次/end；
   *  2) 没有完整 <|start|> 但末尾有 <|：那是不成形的新标记残片（被截断在 <|start|> 之前），保留；
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
    if (this.channel && THINKING_CHANNELS.has(this.channel)) {
      this.emitThinking(clean)
    } else {
      this.emitDelta(clean)
    }
  }
}
