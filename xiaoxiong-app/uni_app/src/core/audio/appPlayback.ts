/**
 * App 端 TTS PCM 播放：走 app-product-wake 原生插件的 AudioTrack 接口。
 *
 * 为什么不用 h5Audio.playPcm：它依赖 WebAudio(AudioContext)，而 App 逻辑层是独立 JS 引擎、
 * 没有 WebAudio，TTS 二进制帧到了也播不出声（用户反馈「文字不播报」）。所以 App 端必须由
 * 原生 AudioTrack 顺序写入 PCM，并在队列播空时回调 idle，供上层对齐 tts.end 的播放完成回执。
 *
 * 与采集（appCapture.ts）共用同一个原生模块 id：app-product-wake。
 * 不用条件编译消除 import——loadModule 内做能力保护，插件缺失时降级返回 false，由门面分流到 H5。
 */

interface NativePlaybackModule {
  startPlayback?(sampleRate: number): void
  /** JS 传 0–255 的字节数组，DCloud 桥转成原生 JSONArray */
  playPcm?(data: number[]): void
  stopPlayback?(): void
  /** keepAlive 回调：每次播放队列清空且录音头追上写入进度时回传 true */
  onPlaybackIdle?(callback: (idle: boolean) => void): void
}

/** 模块实例必须缓存：app-product-wake 是非单例，每帧重新 require 会拿到不同实例，PCM 被投给各自独立的原生队列而播不连贯。 */
let cachedModule: NativePlaybackModule | null | undefined

function loadModule(): NativePlaybackModule | null {
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
    const mod = scope.requireNativePlugin('app-product-wake') as NativePlaybackModule | null | undefined
    cachedModule = mod ?? null
    return cachedModule
  } catch {
    cachedModule = null
    return null
  }
}

/** 插件实现了 PCM 播放接口才算可用；旧基座只支持采集时返回 false。 */
export function isAppPlaybackSupported(): boolean {
  const mod = loadModule()
  return !!mod && typeof mod.playPcm === 'function' && typeof mod.stopPlayback === 'function'
}

/** 播空回调只绑一次；原生回调 keepAlive，靠这里的监听集合转发给当前等待者。 */
let idleBound = false
const idleListeners = new Set<() => void>()
/**
 * 是否有在途 PCM 等待播完。第一帧 playPcm 置 true，原生 idle 回调或 stopPlayback 置 false。
 * tts.end 注册 idle 时若已播完（PCM 短、原生 idle 先到），必须立即兑现回调，
 * 否则等待者永远挂起、网关收不到播完回执、排队句卡死——与 h5Audio.onPlaybackIdle 的
 * 「队列本来就空时立即执行」语义对齐。
 */
let playbackInFlight = false

function bindIdleOnce(mod: NativePlaybackModule): void {
  if (idleBound) return
  idleBound = true
  mod.onPlaybackIdle?.((idle) => {
    if (idle !== true) return
    emitIdle()
  })
}

function emitIdle(): void {
  playbackInFlight = false
  if (!idleListeners.size) return
  const pending = [...idleListeners]
  idleListeners.clear()
  pending.forEach((fn) => fn())
}

/**
 * 原生 AudioTrack 顺序播放一段 16bit PCM；第一帧会自动起播，调用方可连续投帧。
 * 转换按字节逐位 & 0xff，兼容 weex 桥对有符号/无符号的语义差异。
 */
export function appPlayPcm(pcm: ArrayBuffer, sampleRate = 24000): void {
  const mod = loadModule()
  if (!mod?.playPcm) return
  bindIdleOnce(mod)
  const bytes = new Uint8Array(pcm)
  if (bytes.length === 0) return
  const data: number[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) data[i] = bytes[i] & 0xff
  playbackInFlight = true
  mod.playPcm(data)
}

/**
 * 注册「所有排队音频播完」的一次性回调。已经播完（含从未播放）时立即执行。
 * 停止播放也视作播空（避免 tts.stop 后等待者永远挂起）。
 */
export function onAppPlaybackIdle(fn: () => void): () => void {
  if (!playbackInFlight) {
    fn()
    return () => {}
  }
  idleListeners.add(fn)
  return () => {
    idleListeners.delete(fn)
  }
}

/** 打断/新一轮开始前掐掉正在播的音频。 */
export function stopAppPlayback(): void {
  const mod = loadModule()
  try {
    mod?.stopPlayback?.()
  } catch {
    // 重复停止忽略
  }
  emitIdle()
}
