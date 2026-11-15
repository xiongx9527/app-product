/**
 * App 端本地提示音播放门面：走 app-product-wake 原生插件的 MediaPlayer 接口。
 *
 * 为什么不用 uni.createInnerAudioContext（promptPlayer.playOneCue 的老路）：
 * App 端 InnerAudioContext 底层 io.dcloud.feature.audio.AudioPlayer 会
 * requestAudioFocus(AUDIOFOCUS_GAIN)，抢走正在播放音乐的 InnerAudioContext 的焦点，
 * 音乐被系统 pause 且不自动恢复（真机 logcat 已证实 abandonAudioFocus/requestAudioFocus
 * 均来自 AudioPlayer$1）。裸 MediaPlayer 默认不申请音频焦点，可与音乐并发出声；
 * 提示音期间由 duckMusic 压低音乐音量，播完恢复，对标 H5 的 ducking。
 *
 * 与采集/播放共用同一个原生模块 id：app-product-wake；模块实例必须缓存（非单例）。
 * 旧基座只支持采集/PCM 播放、没有 playCue 时，isAppCueSupported() 返回 false，
 * 由 promptPlayer 降级回 InnerAudioContext（至少能出声）。
 */

interface NativeCueModule {
  onCueEnd?(callback: (completed: boolean) => void): void
  playCue?(file: string): void
  stopCue?(): void
}

let cachedModule: NativeCueModule | null | undefined

function loadModule(): NativeCueModule | null {
  if (cachedModule !== undefined) return cachedModule
  if (typeof uni === 'undefined') {
    cachedModule = null
    return null
  }
  const scope = uni as unknown as { requireNativePlugin?: (name: string) => unknown }
  if (typeof scope.requireNativePlugin !== 'function') {
    cachedModule = null
    return null
  }
  try {
    const mod = scope.requireNativePlugin('app-product-wake') as NativeCueModule | null | undefined
    cachedModule = mod ?? null
    return cachedModule
  } catch {
    cachedModule = null
    return null
  }
}

/** 原生是否实现了提示音播放接口；否则调用方降级到 InnerAudioContext。 */
export function isAppCueSupported(): boolean {
  const mod = loadModule()
  return !!mod && typeof mod.playCue === 'function'
}

/** 播空/出错回调只绑一次。keepAlive 原生回调，转发给当前等待者。 */
let endBound = false
const endListeners = new Set<(completed: boolean) => void>()

function bindEndOnce(mod: NativeCueModule): void {
  if (endBound) return
  endBound = true
  mod.onCueEnd?.((completed) => {
    const pending = [...endListeners]
    endListeners.clear()
    pending.forEach((fn) => fn(completed === true))
  })
}

/**
 * 播一个打包内提示音（file 如 greeting.mp3）。返回是否真正投给原生。
 * 调用方负责 duckMusic：播前压低、回调/超时后恢复。
 */
export function appPlayCue(file: string, onEnd?: (completed: boolean) => void): boolean {
  const mod = loadModule()
  if (!mod?.playCue) return false
  bindEndOnce(mod)
  if (onEnd) endListeners.add(onEnd)
  // 必须传标量字符串：DCloud/weex 桥对 JSONObject 参数会丢字段（真机实测 arg={}）
  mod.playCue(file)
  return true
}

/** 打断当前提示音（新一轮提示 / 会话结束时），并兑现所有等待者。 */
export function stopAppCue(): void {
  const mod = loadModule()
  try {
    mod?.stopCue?.()
  } catch {
    // 重复停止忽略
  }
  const pending = [...endListeners]
  endListeners.clear()
  pending.forEach((fn) => fn(false))
}
