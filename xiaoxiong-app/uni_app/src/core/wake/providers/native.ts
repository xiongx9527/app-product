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
  start(options: { words: string[]; lang?: string }): void
  stop(): void
  onWake(callback: () => void): void
  onError(callback: (payload: { message?: string } | string) => void): void
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
  let wakeHandler: (() => void) | null = null

  function resolvePlugin(): NativeWakeModule | null {
    if (!plugin) plugin = loadPlugin()
    return plugin
  }

  function bind(instance: NativeWakeModule): void {
    if (bound) return
    bound = true
    instance.onWake(() => {
      if (running) wakeHandler?.()
    })
    instance.onError((payload) => {
      // 原生层错误只记录，不打断会话；界面会展示最近一条错误
      const message =
        typeof payload === 'string' ? payload : payload?.message ?? '原生唤醒异常'
      console.warn('[wake]', message)
    })
  }

  return {
    name: '原生 KWS',

    isSupported() {
      return resolvePlugin() !== null
    },

    start(onWake, onError) {
      wakeHandler = onWake
      const instance = resolvePlugin()
      if (!instance) {
        onError?.('原生唤醒插件未安装，需自定义基座打包')
        return
      }
      bind(instance)
      if (running) return
      running = true
      try {
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
        resolvePlugin()?.stop()
      } catch {
        // 忽略重复停止
      }
    },
  }
}
