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
  /**
   * 最近一次 finalize 音频里 VAD 判出的「真人语音」秒数（仅内置 SenseVoice 有）。
   * -1/undefined = 无 VAD 数据（上游 ASR 或未装模型），调用方据此跳过二级判断。
   * 可选：上游 ASR 实现不需要提供。
   */
  speechDuration?: number
}
