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
  /** KWS 就绪回调：payload { ready: boolean } 或布尔值 */
  onReady?(callback: (payload: { ready?: boolean } | boolean) => void): void
  /** 待唤醒态上行静音（唤醒前不调 ASR）：iOS 实现，Android 可缺省 */
  setStandbyMuted?(muted: boolean): void
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
    // 每个回调注册独立容错：DCloud 桥接下某个方法调用失败不应阻断其余绑定，
    // 更不能让 start() 因此跳过（KWS 引擎在原生侧，回调注册失败只影响事件接收）。
    try {
      instance.onWake?.((payload) => {
        if (running) wakeHandler?.(wakeWordOf(payload))
      })
    } catch (e) { console.warn('[wake] onWake 绑定失败', e) }
    try {
      instance.onError?.((payload) => {
        // 原生层错误只记录，不打断会话；界面会展示最近一条错误
        const message =
          typeof payload === 'string' ? payload : payload?.message ?? '原生唤醒异常'
        console.warn('[wake]', message)
      })
    } catch (e) { console.warn('[wake] onError 绑定失败', e) }
  }

  return {
    name: '原生 KWS',

    isSupported() {
      // 插件存在即视为支持 KWS。app-product-wake 在 Android/iOS 都已补齐 start/onWake/stop。
      // 注意：DCloud weex 桥接暴露的方法用 `typeof instance.start === 'function'` 判断不可靠
      // （真机实测方法列表里有 start/onWake，但 typeof 不为 function），会导致 KWS 被误判为不支持、
      // 永不启动。安全兜底交给 start() 的 try/catch + useAssistant.enable() 的 catch，
      // 方法真缺失时也不会再卡死。
      return resolvePlugin() !== null
    },

    start(onWake, onError) {
      wakeHandler = onWake
      const instance = resolvePlugin()
      if (!instance) return
      try {
        bind(instance)
        if (running) return
        running = true
        instance.start?.({ words: [...wakeWords], lang: options.lang })
      } catch {
        running = false
        onError?.('原生唤醒启动失败')
      }
    },

    onReady(callback) {
      // 原生 KWS 异步加载完成/失败会回调；必须在 start() 之前绑定（原生侧也有"已 ready 立即兑现"保护）
      const instance = resolvePlugin()
      if (!instance?.onReady) return
      try {
        instance.onReady((payload) => {
          // 原生回调的 ready 经 DCloud/weex 桥可能是 boolean、number(1/0) 或 {ready}：
          // iOS @YES/@NO 桥过来常是 number 1/0，旧逻辑只认 boolean 会把 1 误判成 false →
          // wakeReady 卡在 failed、「已就绪」提示不播。三种格式都兼容。
          let ready: boolean
          if (typeof payload === 'boolean') ready = payload
          else if (typeof payload === 'number') ready = payload !== 0
          else ready = !!(payload as { ready?: boolean } | null)?.ready
          callback(ready)
        })
      } catch (e) { console.warn('[wake] onReady 绑定失败', e) }
    },

    setStandbyMuted(muted: boolean) {
      // 待唤醒态把上行 PCM 置静音，避免采集音频被网关当用户输入（唤醒前不调 ASR）。
      // iOS 原生实现；Android 暂缺省（无该方法时静默跳过）。
      try {
        resolvePlugin()?.setStandbyMuted?.(muted)
      } catch (e) { console.warn('[wake] setStandbyMuted 失败', e) }
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
