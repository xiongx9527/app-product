/** 唤醒实现抽象：App（目标端）/ H5（开发阶段）各自提供实现，上层只认这个接口 */
export interface WakeProvider {
  /** 界面展示用的实现名，例如“浏览器语音”“原生 KWS” */
  readonly name: string
  isSupported(): boolean
  start(onWake: () => void, onError?: (message: string) => void): void
  stop(): void
}

/** 默认唤醒词，后续可按产品命名调整 */
export const DEFAULT_WAKE_WORDS: string[] = ['小熊小熊']
