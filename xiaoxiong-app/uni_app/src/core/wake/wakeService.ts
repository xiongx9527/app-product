import type { WakeProvider } from './types'
import { DEFAULT_WAKE_WORDS } from './types'
import { createNativeWakeProvider } from './providers/native'
import { createUnsupportedProvider } from './providers/unsupported'
import { createWebSpeechProvider } from './providers/webSpeech'
import { getLanguage } from '@/core/config'

/**
 * 唤醒服务。
 *
 * 按端选择实现：
 * - App（目标端）：原生插件 app-product-wake（sherpa-onnx KWS）
 * - H5（仅开发阶段）：浏览器 Web Speech API（先跑通链路，非离线）
 * - 小程序与鸿蒙确定不支持，不提供实现。
 *
 * 注意条件编译：APP-PLUS 命中目标端 Android/iOS；不依赖预处理消除 import。
 */
export interface WakeService {
  start(): void
  stop(): void
  isSupported(): boolean
  /**
   * 待唤醒态上行静音（唤醒前不调 ASR）：true=静音上行，false=恢复。
   * 未实现该能力的端为空操作。
   */
  setStandbyMuted(muted: boolean): void
  /** 当前端实际使用的实现名，供界面展示 */
  readonly providerName: string
}

export interface WakeServiceOptions {
  /** KWS 命中回调；word 为命中的唤醒词（可能为空，用默认词兜底） */
  onWake: (word?: string) => void
  onError?: (message: string) => void
  /** KWS 就绪态：true=模型加载完成可喊词，false=加载失败（点圆球兜底） */
  onReady?: (ready: boolean) => void
  wakeWords?: readonly string[]
  /** 识别语言，默认取配置页里的全局语言 */
  lang?: string
}

export function createWakeService(options: WakeServiceOptions): WakeService {
  const words = options.wakeWords ?? DEFAULT_WAKE_WORDS
  const lang = options.lang ?? getLanguage()
  const provider = selectProvider(words, lang)
  let running = false

  return {
    start() {
      if (running) return
      if (!provider.isSupported()) {
        // 端不支持唤醒：界面按「不可用」展示，引导用户点圆球
        options.onReady?.(false)
        return
      }
      running = true
      if (options.onReady) {
        if (provider.onReady) {
          // 原生侧 KWS 异步加载（约 1–3s），完成/失败会回调；必须在 start() 之前绑定
          provider.onReady(options.onReady)
        } else {
          // 没有异步加载过程的端（H5 浏览器语音）恒可唤醒
          options.onReady(true)
        }
      }
      provider.start(options.onWake, options.onError)
    },

    stop() {
      if (!running) return
      running = false
      provider.stop()
    },

    isSupported() {
      return provider.isSupported()
    },

    setStandbyMuted(muted: boolean) {
      try {
        provider.setStandbyMuted?.(muted)
      } catch (e) {
        console.warn('[wake] setStandbyMuted 失败', e)
      }
    },

    get providerName() {
      return provider.name
    },
  }
}

function selectProvider(words: readonly string[], lang: string): WakeProvider {
  // #ifdef H5
  return createWebSpeechProvider(words, { lang })
  // #endif

  // #ifdef APP
  return createNativeWakeProvider(words, { lang })
  // #endif

  return createUnsupportedProvider()
}
