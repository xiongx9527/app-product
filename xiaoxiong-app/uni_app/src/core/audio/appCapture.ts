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
  /** iOS 专用：熄屏/中断/回前台后强制重建 AVAudioEngine 采集（幂等，旧基座没有则降级） */
  ensureCapture?(): void
  /** iOS 专用：唤醒对话期间保持屏幕常亮（禁 idleTimer），回待唤醒恢复；避免后台 CPU 超限被杀 */
  keepScreenOn?(on: boolean): void
  /** iOS 专用：媒体播放器(音乐/新闻)播放期间静音上行，防外放声音被麦克风收回识别成用户输入 */
  setMediaPlaying?(on: boolean): void
  /** duck 配置：中断前 duck 开关 + 强度百分比 + 插话开关。旧基座无此方法则降级。 */
  setDuckConfig?(interruptDuck: boolean, percent: number, bargeIn: boolean): void
  /** 硬件 AEC 开关（对照实验）：开=采集全程开系统 AEC（含播报期）。旧基座降级。 */
  setAecUserEnabled?(enabled: boolean): void
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

/** base64 解码（App 逻辑层无 atob/Buffer，手写纯位运算；与 appPlayback.ts 的 B64_CHARS 同表） */
const PCM_B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decodePcmBase64(s: string): Uint8Array {
  const len = s.length
  const outLen = Math.floor((len * 3) / 4)
  const bytes = new Uint8Array(outLen)
  let out = 0
  for (let i = 0; i < len; i += 4) {
    const c0 = PCM_B64_CHARS.indexOf(s[i])
    const c1 = PCM_B64_CHARS.indexOf(s[i + 1])
    const c2 = s[i + 2] === '=' ? 0 : PCM_B64_CHARS.indexOf(s[i + 2])
    const c3 = s[i + 3] === '=' ? 0 : PCM_B64_CHARS.indexOf(s[i + 3])
    if (out < outLen) bytes[out++] = ((c0 << 2) | (c1 >> 4)) & 0xff
    if (out < outLen) bytes[out++] = ((c1 << 4) | (c2 >> 2)) & 0xff
    if (out < outLen) bytes[out++] = ((c2 << 6) | c3) & 0xff
  }
  return bytes
}

/**
 * 原生回调统一成 ArrayBuffer。
 *
 * 两端原生回传格式不同（公共代码必须都兼容）：
 * - Android：byte[] 经 DCloud weex 桥转成「普通 JS number[]」→ 走 Array.isArray 分支。
 * - iOS：NSData 经 weex 桥是 [object NSData]（既非 ArrayBuffer 也非 number[]，toArrayBuffer 拿到会
 *   返回 null → 每帧丢弃 → 网关收不到音频、唤醒后无法对话）。iOS 原生改传 base64 标量字符串
 *   （标量字符串过桥可靠，与 TTS playPcm 同款），这里走 string 分支解码。
 */
function toArrayBuffer(frame: unknown): ArrayBuffer | null {
  if (frame instanceof ArrayBuffer) return frame
  if (ArrayBuffer.isView(frame)) {
    const view = frame as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  if (typeof frame === 'string' && frame.length > 0) {
    // iOS base64 帧（标量字符串过桥可靠）
    return decodePcmBase64(frame).buffer as ArrayBuffer
  }
  if (Array.isArray(frame)) {
    // Android number[] 帧（weex 桥对 byte[] 的转换结果）
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
    const did = getDeviceId()
    try {
      if (typeof instance.configureDirectUpload === 'function') {
        instance.configureDirectUpload(did)
      }
    } catch {
      // 旧基座无此方法或配置失败：降级走 weex 回调路径，不影响 startPcm。
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
 * 回前台/熄屏结束后让原生强制自检并重建采集。
 * iOS 上熄屏期间 AVAudioEngine 的 input tap 可能被系统/保活会话掐断，且不一定会自动恢复；
 * 原生侧有中断监听和 2s 看门狗，这里再由 onAppShow 补一次强制重建兜底。
 * 只在 JS 认为采集仍在进行时生效；旧基座无 ensureCapture 时静默降级。
 */
export function resumeAppCapture(): void {
  if (!running) return
  const instance = boundInstance ?? mod
  if (!instance || typeof instance.ensureCapture !== 'function') return
  try {
    instance.ensureCapture()
  } catch {
    // 旧基座方法异常不影响其余回前台收尾
  }
}

/**
 * 唤醒对话期间保持屏幕常亮（禁 iOS idleTimer），回待唤醒时恢复。
 * iOS 熄屏后进后台：① uni.getLocation 拿不到定位（天气首次问失败）；
 * ② KWS 推理+采集+内嵌网关持续高 CPU 会触发 task_exceeded_cpulimit 被系统杀进程（体感「崩了」）。
 * 对话期间常亮即可同时规避这两点。旧基座无此方法时静默降级。
 *
 * 【租约兜底】网关卡死时前端看门狗 force settle 不走 enterWake、不会调 false，
 * 屏幕会永久常亮（真机 2026-11-23「卡在正在思考 + 不熄屏」）。故 true 时挂一个
 * 最大 90s 的自动熄灭定时器：对话正常结束（leaveWake/enterWake）调 false 会取消；
 * 卡死无人收尾时到点也强制熄灭，绝不永久亮屏。每次 true 续租。
 */
const SCREEN_ON_LEASE_MS = 90_000
let screenOnLeaseTimer: ReturnType<typeof setTimeout> | null = null

function applyScreenOn(on: boolean): void {
  const instance = boundInstance ?? mod ?? loadPcmModule()
  if (!instance || typeof instance.keepScreenOn !== 'function') return
  try {
    instance.keepScreenOn(on)
  } catch {
    // 旧基座无此方法：降级为不保屏
  }
}

export function setAppScreenOn(on: boolean): void {
  if (screenOnLeaseTimer) {
    clearTimeout(screenOnLeaseTimer)
    screenOnLeaseTimer = null
  }
  applyScreenOn(on)
  if (on) {
    screenOnLeaseTimer = setTimeout(() => {
      screenOnLeaseTimer = null
      applyScreenOn(false) // 租约到期强制熄灭，防卡死永久亮屏
    }, SCREEN_ON_LEASE_MS)
  }
}

/** 媒体播放器(音乐/新闻/电台)播放期间通知原生静音上行：外放声音不经网关TTS、
 *  网关 AEC 无参考信号消不掉，不静音会被麦克风收回识别成用户输入。KWS 仍照常听。 */
export function setMediaPlaying(on: boolean): void {
  const instance = boundInstance ?? mod ?? loadPcmModule()
  if (!instance || typeof instance.setMediaPlaying !== 'function') return
  try {
    instance.setMediaPlaying(on)
  } catch {
    // 旧基座无此方法：降级
  }
}

/** 下发 duck 配置到原生：中断前 duck 开关、强度百分比（压低后保留音量）、插话开关。
 *  设置页改动即调；启动 Assistant 时也调一次把落盘配置同步到原生。旧基座无此方法降级。 */
export function setDuckConfig(interruptDuck: boolean, percent: number, bargeIn: boolean): void {
  const instance = boundInstance ?? mod ?? loadPcmModule()
  if (!instance || typeof instance.setDuckConfig !== 'function') return
  try {
    instance.setDuckConfig(interruptDuck, percent, bargeIn)
  } catch {
    // 旧基座无此方法：降级
  }
}

/** 硬件 AEC 开关（对照实验）：下发到原生控制采集源 AEC 全程开/关。 */
export function setAecUserEnabled(enabled: boolean): void {
  const instance = boundInstance ?? mod ?? loadPcmModule()
  if (!instance || typeof instance.setAecUserEnabled !== 'function') return
  try {
    instance.setAecUserEnabled(enabled)
  } catch {
    // 旧基座无此方法：降级
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
