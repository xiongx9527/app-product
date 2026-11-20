import type { WakeProvider } from '../types'

/**
 * App 唤醒实现：uni-app 原生插件桥接。
 *
 * 插件名 app-product-wake，暴露：
 *   start({ words }) / stop() / onWake(cb) / onError(cb)（唤醒）
 *   startPcm / stopPcm / onPcmFrame / onPcmError（实时 PCM 采集，见 core/audio/appCapture.ts）
 *
 * Android / iOS 各自实现，JS 侧只有这一套接口；小程序与鸿蒙不是目标端。
 * 插件还没落地时 isSupported() 返回 false，界面会提示“原生唤醒未就绪”，
 * 不影响按住说话。
 */

interface NativeWakeModule {
  start?(options: { words: string[]; lang?: string }): void
  stop?(): void
  /** 原生 KWS 命中回调：payload 形如 { word: '小熊小熊' }，也可能无参（旧基座） */
  onWake?(callback: (payload?: { word?: string } | string) => void): void
  onError?(callback: (payload: { message?: string } | string) => void): void
}

function wakeWordOf(payload?: { word?: string } | string): string | undefined {
  if (!payload) return undefined
  if (typeof payload === 'string') return payload || undefined
  return payload.word || undefined
}

function loadPlugin(): NativeWakeModule | null {
  if (typeof uni === 'undefined') return null
  const scope = uni as unknown as {
    requireNativePlugin?: (name: string) => unknown
  }
  if (typeof scope.requireNativePlugin !== 'function') return null
  try {
    return scope.requireNativePlugin('app-product-wake') as NativeWakeModule
  } catch {
    return null
  }
}

export function createNativeWakeProvider(
  wakeWords: readonly string[],
  options: { lang?: string } = {}
): WakeProvider {
  let plugin: NativeWakeModule | null = null
  let bound = false
  let running = false
  let wakeHandler: ((word?: string) => void) | null = null

  function resolvePlugin(): NativeWakeModule | null {
    if (!plugin) plugin = loadPlugin()
    return plugin
  }

  function bind(instance: NativeWakeModule): void {
    if (bound) return
    bound = true
    instance.onWake?.((payload) => {
      if (running) wakeHandler?.(wakeWordOf(payload))
    })
    instance.onError?.((payload) => {
      // 原生层错误只记录，不打断会话；界面会展示最近一条错误
      const message =
        typeof payload === 'string' ? payload : payload?.message ?? '原生唤醒异常'
      console.warn('[wake]', message)
    })
  }

  return {
    name: '原生 KWS',

    isSupported() {
      // 插件存在 ≠ 支持 KWS：iOS 插件 app-product-wake 只有 PCM 采集方法（startPcm 等），
      // 没有 KWS 的 start/onWake。若仅凭插件存在就认定支持，start() 调 instance.onWake()
      // 会抛 TypeError（且 bind 在 try 外），错误冒泡到 enable()（无 catch）→
      // gatewayPreparing 永远卡 true → 界面永远「网关启动中」。故必须校验方法齐全。
      const instance = resolvePlugin()
      return !!instance && typeof instance.start === 'function' && typeof instance.onWake === 'function'
    },

    start(onWake, onError) {
      wakeHandler = onWake
      const instance = resolvePlugin()
      if (!instance || typeof instance.start !== 'function' || typeof instance.onWake !== 'function') {
        // 插件不支持 KWS（如 iOS 走网关 ASR 唤醒）：安全跳过，不抛错、不卡 enable。
        return
      }
      try {
        bind(instance)
        if (running) return
        running = true
        instance.start({ words: [...wakeWords], lang: options.lang })
      } catch {
        running = false
        onError?.('原生唤醒启动失败')
      }
    },

    stop() {
      if (!running) return
      running = false
      try {
        resolvePlugin()?.stop?.()
      } catch {
        // 忽略重复停止
      }
    },
  }
}
