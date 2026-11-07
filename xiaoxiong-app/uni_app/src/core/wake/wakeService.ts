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
 * - H5：浏览器 Web Speech API（先跑通链路，非离线）
 * - App：原生插件 app-product-wake（sherpa-onnx KWS）
 * - 小程序：不支持常听，降级为按住/点击说话
 *
 * 注意条件编译：APP-PLUS 只命中 Android/iOS，鸿蒙要用 APP 或 APP-HARMONY。
 */
export interface WakeService {
  start(): void
  stop(): void
  isSupported(): boolean
  /** 当前端实际使用的实现名，供界面展示 */
  readonly providerName: string
}

export interface WakeServiceOptions {
  onWake: () => void
  onError?: (message: string) => void
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
      if (!provider.isSupported()) return
      running = true
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
