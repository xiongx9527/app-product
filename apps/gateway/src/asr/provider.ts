/**
 * ASR（语音识别）抽象：网关把客户端上行的一段段麦克风 PCM 喂进来，
 * 引擎自行做端点检测，在句末产出最终文本。
 */
export interface AsrProvider {
  /** 喂一段 PCM 音频，可返回实时中间结果（partial），无则返回 null */
  push(chunk: Uint8Array): Promise<string | null>
  /** 一句话结束，产出最终识别文本 */
  finalize(): Promise<string>
  /** 重置，开始下一轮 */
  reset(): void
}
