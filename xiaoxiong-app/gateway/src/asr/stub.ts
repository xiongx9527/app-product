import type { AsrProvider } from './provider'

/**
 * 占位 ASR：不识别真实语音，句末直接回一个固定提示文本。
 * 作用是让协议与 AgentScope 串流在没接真实引擎时也能端到端跑通。
 */
export class StubAsr implements AsrProvider {
  private used = false

  async push(): Promise<string | null> {
    return null
  }

  async finalize(): Promise<string> {
    if (this.used) return ''
    this.used = true
    return '（本地 ASR 待接入：请改 src/asr/http.ts 对接 192.168.1.100:9529 的真实引擎）'
  }

  reset(): void {
    this.used = false
  }
}
