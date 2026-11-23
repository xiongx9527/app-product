/** 唤醒实现抽象：App（目标端）/ H5（开发阶段）各自提供实现，上层只认这个接口 */
export interface WakeProvider {
  /** 界面展示用的实现名，例如“浏览器语音”“原生 KWS” */
  readonly name: string
  isSupported(): boolean
  /**
   * 唤醒回调。word 是端侧 KWS 命中的词（可能为空：H5 回退或原生未回传时用默认词）。
   * 上层据此把命中路由到「唤醒」或「播报期打断」。
   */
  start(onWake: (word?: string) => void, onError?: (message: string) => void): void
  /** 绑定 KWS 就绪回调（模型加载完成才可喊词；未就绪时可点圆球兜底）。raw 是原生原始 payload，仅用于诊断 */
  onReady?(callback: (ready: boolean, raw?: unknown) => void): void
  /** 待唤醒态上行静音（唤醒前不调 ASR）；iOS 实现，Android 可缺省 */
  setStandbyMuted?(muted: boolean): void
  stop(): void
}

/** 默认唤醒词，后续可按产品命名调整。
 *  matchWakeWord 用 includes，标准词放最前优先命中。
 *  2026-11-23 从"小熊小熊"改为"你好小熊"：KWS 的 token 重复序列（x iǎo x ióng ×2）
 *  会让解码路径歧义、命中率极低；"你好小熊"四音节无重复，召回更稳。
 *  别放太短的词（"你好"/"小熊"）会误触发（"你好呀"/"小熊饼干"等）。 */
export const DEFAULT_WAKE_WORDS: string[] = ['你好小熊', '你好小小熊']
