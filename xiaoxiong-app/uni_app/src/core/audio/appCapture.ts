import { markMicGranted } from './micEvidence'

/**
 * App 端实时 PCM 采集：走 app-product-wake 原生插件扩展的 PCM 接口。
 *
 * 为什么不用 uni.getRecorderManager：它只能录成文件（onStop 才给 tempFilePath），
 * App 端不支持 onFrameRecorded，拿不到 20-40ms 的持续分片，无法满足网关
 * 「16k/16bit/单声道 PCM 分片上行」的契约（见 contracts/README.md）。
 * 由原生层（Android AudioRecord / iOS AVAudioEngine）直接吐 PCM 帧，
 * JS 侧只负责把帧透传给 transport。小程序与鸿蒙不是目标端，不在此实现。
 *
 * 插件未在自定义基座里落地时 isSupported() 为 false，调用方须降级并提示，
 * 禁止直接抛到 UI。导入在函数内做能力保护，不依赖条件编译消除 import。
 */

/** 与网关上行契约一致：16k / 16bit / 单声道 / 32ms 分片。 */
export const APP_PCM_CONFIG = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  frameMs: 32,
} as const

interface NativePcmModule {
  startPcm?(options: {
    sampleRate: number
    channels: number
    bitsPerSample: number
    frameMs: number
  }): void
  stopPcm?(): void
  onPcmFrame?(callback: (frame: ArrayBuffer) => void): void
  onPcmError?(callback: (payload: { message?: string } | string) => void): void
}

function loadPcmModule(): NativePcmModule | null {
  if (typeof uni === 'undefined') {
    console.warn('[appCapture] uni undefined')
    return null
  }
  const scope = uni as unknown as {
    requireNativePlugin?: (name: string) => unknown
  }
  if (typeof scope.requireNativePlugin !== 'function') {
    console.warn('[appCapture] requireNativePlugin 不可用')
    return null
  }
  try {
    const mod = scope.requireNativePlugin('app-product-wake') as NativePcmModule
    console.warn('[appCapture] requireNativePlugin(app-product-wake) =>', mod ? Object.keys(mod as object) : 'null')
    return mod
  } catch (e) {
    console.warn('[appCapture] requireNativePlugin threw', e)
    return null
  }
}

/** 插件存在且实现了 PCM 接口才算可用；旧基座只支持唤醒时返回 false。 */
export function isAppCaptureSupported(): boolean {
  const mod = loadPcmModule()
  const ok =
    mod !== null &&
    typeof mod.startPcm === 'function' &&
    typeof mod.stopPcm === 'function' &&
    typeof mod.onPcmFrame === 'function'
  console.warn('[appCapture] isAppCaptureSupported =>', ok)
  return ok
}

/** 原生回调可能给 ArrayBuffer 或类型化数组，统一成 ArrayBuffer。 */
function toArrayBuffer(frame: unknown): ArrayBuffer | null {
  if (frame instanceof ArrayBuffer) return frame
  if (ArrayBuffer.isView(frame)) {
    const view = frame as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  return null
}

let mod: NativePcmModule | null = null
let running = false
/** 记住「已给哪个插件实例绑过回调」而不是布尔：实例被重建（重连/重武装）时要重新绑定。 */
let boundInstance: NativePcmModule | null = null
/** 当前一轮的接收者：原生回调只绑一次，靠持有者转发，避免重启后仍用旧闭包。 */
let onChunkCurrent: (pcm: ArrayBuffer) => void = () => {}
let onErrorCurrent: (message: string) => void = () => {}

/**
 * 启动 App 端 PCM 采集。成功返回 true；插件不可用/启动失败返回 false 由调用方降级。
 * onChunk 收到的是 16k/16bit/mono PCM 帧，直接送 transport.sendAudioChunk。
 */
export function startAppCapture(
  onChunk: (pcm: ArrayBuffer) => void,
  onError: (message: string) => void
): boolean {
  if (running) return true
  const instance = loadPcmModule()
  if (!isAppCaptureSupported() || !instance) return false
  mod = instance
  onChunkCurrent = onChunk
  onErrorCurrent = onError

  if (boundInstance !== instance) {
    boundInstance = instance
    instance.onPcmFrame?.((frame) => {
      if (!running) return
      const pcm = toArrayBuffer(frame)
      if (pcm && pcm.byteLength > 0) onChunkCurrent(pcm)
    })
    instance.onPcmError?.((payload) => {
      const message =
        typeof payload === 'string' ? payload : payload?.message ?? '原生录音异常'
      onErrorCurrent(message)
    })
  }

  try {
    instance.startPcm?.({ ...APP_PCM_CONFIG })
    running = true
    markMicGranted()
    return true
  } catch {
    return false
  }
}

/** 停止 App 端采集；与 stopCapture 互斥（同一时刻只有一个后端在跑）。 */
export function stopAppCapture(): void {
  if (!running) return
  running = false
  try {
    mod?.stopPcm?.()
  } catch {
    // 重复停止忽略
  }
}

/**
 * 调 startAppCapture 前，确保麦克风权限已授予（仅 App 端需要）。
 *
 * 为什么必须前端请求：原生 AudioRecord 不走 uni-app 的录音 API，框架不会代为弹权限框；
 * 而 WXModule 也不保证把 onRequestPermissionsResult 转发到插件，所以权限申请只能放在 JS 侧。
 * App 端用 uni.authorize(scope.record) 触发系统麦克风权限弹窗（映射 RECORD_AUDIO）。
 * 返回 true = 已授权；false = 用户拒绝或未授予，调用方应提示并停止采集，不要继续连网关空等。
 */
export function requestMicPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    const scope = uni as unknown as {
      authorize?: (opt: {
        scope: string
        success?: () => void
        fail?: () => void
      }) => void
    }
    if (typeof scope.authorize !== 'function') {
      // 非 App 端（H5 由浏览器自己管权限，且本函数只在 isAppCaptureSupported 分支调用）
      resolve(true)
      return
    }
    scope.authorize({
      scope: 'scope.record',
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}
