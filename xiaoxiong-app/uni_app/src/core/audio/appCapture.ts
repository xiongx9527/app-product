import { markMicGranted, hasMicBeenGranted } from './micEvidence'
import { readAppPermissionsSync } from '@/core/permission/permissionStatus'
import { getDeviceId } from '@/core/config/deviceId'

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
  /** 配置原生 PCM 直连网关（绕开播报期失效的 weex 回调）；标量 String 参数可靠过桥 */
  configureDirectUpload?(deviceId: string): void
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
    const mod = scope.requireNativePlugin('app-product-wake') as NativePcmModule | null | undefined
    console.warn('[appCapture] requireNativePlugin(app-product-wake) =>', mod ? Object.keys(mod as object) : String(mod))
    // requireNativePlugin 找不到插件时返回 undefined（不是 null）；两种都要归一成 null，
    // 否则 isAppCaptureSupported 访问 mod.startPcm 会抛 "Cannot read property ... of undefined"，
    // 异常冒泡到 enterWake() 会把整条唤醒链路中断。
    if (!mod) return null
    return mod
  } catch (e) {
    console.warn('[appCapture] requireNativePlugin threw', e)
    return null
  }
}

/** 插件存在且实现了 PCM 接口才算可用；旧基座只支持唤醒时返回 false。 */
export function isAppCaptureSupported(): boolean {
  const mod = loadPcmModule()
  if (!mod) return false
  const ok =
    typeof mod.startPcm === 'function' &&
    typeof mod.stopPcm === 'function' &&
    typeof mod.onPcmFrame === 'function'
  console.warn('[appCapture] isAppCaptureSupported =>', ok)
  return ok
}

/**
 * 原生回调统一成 ArrayBuffer。
 *
 * 关键：DCloud/weex 桥不认识裸 byte[]，会把原生 byte[] 转成「普通 JS number[]」回传
 * （真机实测 ctor=Array / len=1024 / 非 ArrayBuffer 非 TypedArray），而不是 ArrayBuffer。
 * 只认 ArrayBuffer/ArrayBufferView 会把每一帧都丢掉 → 网关收不到任何音频 → 无法唤醒。
 * 因此必须兼容 number[]：按字节灌进 Uint8Array。
 */
function toArrayBuffer(frame: unknown): ArrayBuffer | null {
  if (frame instanceof ArrayBuffer) return frame
  if (ArrayBuffer.isView(frame)) {
    const view = frame as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  if (Array.isArray(frame)) {
    const bytes = new Uint8Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const b = (frame as unknown[])[i]
      bytes[i] = typeof b === 'number' ? b & 0xff : 0
    }
    return bytes.buffer
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
    // 配置原生 PCM 直连网关上报：绕开播报期失效的 weex keepAlive 回调。
    // 失败不影响 startPcm（旧基座无此方法时只走 weex 回调，降级为原状）。
    try {
      instance.configureDirectUpload?.(getDeviceId())
    } catch {
      // 降级：旧基座不支持原生直连
    }
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
  // 先只读检查：已授权就直接采集，不再走 uni.authorize。
  // 关键：真机实测某些 uni 版本对「已授权」的 scope.record 仍走 fail 回调（或不回调），
  // 若只认 authorize 结果，重装后系统已授权却永远采不到音 → 待唤醒但喊词无反应。
  const current = readAppPermissionsSync()
  if (current && current.mic === 'granted') return Promise.resolve(true)
  // 「录音曾成功」是最硬的实证：既然采到过音，权限一定在，直接放行。
  if (hasMicBeenGranted()) return Promise.resolve(true)

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
    let settled = false
    const finish = (granted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(granted)
    }
    // 死循环根因兜底：App 端对「系统已通过 adb pm grant 授权」的 scope.record，
    // uni.authorize 可能既不回调 success 也不回调 fail → Promise 永久挂起 →
    // ensureCapture 卡在 await → startAppCapture 永不执行 → 待唤醒但不采集、喊词无反应。
    // 超时后只读复查：拿得到明确授权就放行；仍 unknown 也放行，把权限最终判定交给
    // 原生 startPcm 内部的 ContextCompat.checkSelfPermission（无权限会 emitError 回报）。
    // 绝不因为 authorize 不回调就把采集链路永久卡死。
    const timer = setTimeout(() => {
      const after = readAppPermissionsSync()
      finish(!after || after.mic !== 'denied')
    }, 1500)
    try {
      scope.authorize({
        scope: 'scope.record',
        success: () => finish(true),
        fail: () => {
          // authorize 失败后再只读复查一次：可能已弹框被系统记为授权，只是回调语义不可靠。
          const after = readAppPermissionsSync()
          finish(!!after && after.mic === 'granted')
        },
      })
    } catch {
      finish(true)
    }
  })
}
