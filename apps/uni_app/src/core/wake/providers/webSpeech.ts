import type { WakeProvider } from '../types'
import { matchWakeWord } from '../wakeWord'
import { APP_LANGUAGE } from '../../config'

/**
 * H5 唤醒实现：浏览器 Web Speech API。
 *
 * 注意：
 * - Chrome / Edge 可用，Safari / Firefox 不稳定；
 * - 识别由浏览器（多数情况是云端）完成，不是离线 KWS；
 * - 只用于把“唤醒 → 打招呼 → 对话”整条链路先跑通，
 *   App 端由 native.ts 的同名接口替换。
 */

interface SpeechAlternativeLike {
  transcript: string
}

interface SpeechResultLike {
  readonly length: number
  readonly isFinal: boolean
  [index: number]: SpeechAlternativeLike
}

interface SpeechResultListLike {
  readonly length: number
  [index: number]: SpeechResultLike
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: SpeechResultListLike
}

interface SpeechRecognitionErrorLike {
  readonly error?: string
  readonly message?: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export interface WebSpeechOptions {
  lang?: string
  /** 浏览器因静音自动断流后，隔多久重新开听 */
  restartDelayMs?: number
  /** 命中唤醒后的冷却时间，避免同一次说话重复触发 */
  cooldownMs?: number
}

export function createWebSpeechProvider(
  wakeWords: readonly string[],
  options: WebSpeechOptions = {}
): WakeProvider {
  const lang = options.lang ?? APP_LANGUAGE
  const restartDelayMs = options.restartDelayMs ?? 400
  const cooldownMs = options.cooldownMs ?? 2000

  let running = false
  let recognition: SpeechRecognitionLike | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let cooldownUntil = 0
  let wakeHandler: (() => void) | null = null
  let errorHandler: ((message: string) => void) | undefined

  function getCtor(): SpeechRecognitionCtor | null {
    if (typeof window === 'undefined') return null
    const scope = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor
      webkitSpeechRecognition?: SpeechRecognitionCtor
    }
    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
  }

  function readTranscript(event: SpeechRecognitionEventLike): string {
    let text = ''
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i]
      const alternative = result?.[0]
      if (alternative?.transcript) text += alternative.transcript
    }
    return text
  }

  function scheduleRestart(): void {
    if (!running) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!running) return
      try {
        recognition?.start()
      } catch {
        // InvalidStateError：上一次还没真正结束，等下一次 onend 再试
      }
    }, restartDelayMs)
  }

  function ensureRecognition(): SpeechRecognitionLike | null {
    if (recognition) return recognition
    const Ctor = getCtor()
    if (!Ctor) return null

    const instance = new Ctor()
    instance.lang = lang
    instance.continuous = true
    instance.interimResults = true
    instance.maxAlternatives = 1

    instance.onresult = (event) => {
      if (!running || Date.now() < cooldownUntil) return
      const matched = matchWakeWord(readTranscript(event), wakeWords)
      if (!matched) return
      cooldownUntil = Date.now() + cooldownMs
      wakeHandler?.()
    }

    instance.onerror = (event) => {
      const code = event.error ?? 'unknown'
      if (code === 'no-speech' || code === 'aborted') return
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        running = false
        errorHandler?.('麦克风未授权，语音唤醒不可用')
        return
      }
      errorHandler?.(`语音唤醒异常：${code}`)
    }

    instance.onend = () => {
      // 浏览器会在静音一段时间后自动结束，重新开听才能持续唤醒
      scheduleRestart()
    }

    recognition = instance
    return instance
  }

  return {
    name: '浏览器语音',

    isSupported() {
      return getCtor() !== null
    },

    start(onWake, onError) {
      wakeHandler = onWake
      errorHandler = onError
      if (running) return

      const instance = ensureRecognition()
      if (!instance) {
        onError?.('当前浏览器不支持语音唤醒，请用 Chrome 或 Edge')
        return
      }

      running = true
      try {
        instance.start()
      } catch {
        running = false
        onError?.('语音唤醒启动失败，请稍后重试')
      }
    },

    stop() {
      running = false
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      try {
        recognition?.abort()
      } catch {
        // 已经停止时忽略
      }
    },
  }
}
