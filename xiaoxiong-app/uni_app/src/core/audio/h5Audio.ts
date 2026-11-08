/**
 * H5 端音频：麦克风采集为 16k/16bit/单声道 PCM 上行，TTS 24k PCM 下行顺序播放。
 * 仅 H5 使用；App 端实时 PCM 走 app-product-wake 原生插件（见 appCapture.ts）——
 * uni.getRecorderManager 只能录成文件、App 不支持 onFrameRecorded，拿不到实时流，
 * 无法满足网关「20-40ms 分片持续上行」的契约，故不用它做对话采集。
 */
import { markMicGranted } from './micEvidence'

type ChunkHandler = (pcm: ArrayBuffer) => void

let captureCtx: AudioContext | null = null
let captureStream: MediaStream | null = null
let captureSource: MediaStreamAudioSourceNode | null = null
let captureProcessor: ScriptProcessorNode | null = null

let playCtx: AudioContext | null = null
let nextStart = 0
const activeSources = new Set<AudioBufferSourceNode>()
/** 等待「排队音频全部播完」的一次性回调；tts.end 早于实际播完，必须靠它对齐。 */
const idleListeners = new Set<() => void>()

function emitIfIdle(): void {
  if (activeSources.size > 0) return
  const pending = [...idleListeners]
  idleListeners.clear()
  pending.forEach((fn) => fn())
}

/**
 * H5 自动播放解锁（仅 H5）。
 * 服务器事件（media.play）触发的 <audio>.play() 不在用户手势调用栈里，
 * 浏览器自动播放策略可能拦截它，表现为「说播放了但没声音」。
 * 在「开启」这类真实手势内播放一段极短静音，解锁页面音频策略，
 * 之后由服务器事件触发的音乐播放才不会被拦。原生端无此限制。
 * 仅在手势同步调用栈内（startCapture 链路）调用一次才有效。
 */
let audioPrimed = false
function silentWavDataUri(): string {
  // 程序生成 0.05s 静音 WAV（16bit/8k/mono），避免内联大段 base64 常量
  const sampleRate = 8000
  const n = Math.floor(sampleRate * 0.05)
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, n * 2, true)
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return 'data:audio/wav;base64,' + btoa(binary)
}

export function primeAudioAutoplay(): void {
  if (audioPrimed || typeof window === 'undefined' || typeof window.Audio === 'undefined') return
  audioPrimed = true
  // WebAudio 播放上下文：在手势内创建并 resume，确保后续 TTS 下行不被 suspended 卡住
  if (!playCtx) {
    try {
      playCtx = createContext()
    } catch {
      // 当前环境无 WebAudio，忽略（原生端不走这里）
    }
  }
  if (playCtx && playCtx.state === 'suspended') void playCtx.resume()
  // HTML5 <audio>：用极短静音播放一次并立即暂停，解锁 document 自动播放策略
  try {
    const a = new window.Audio()
    a.src = silentWavDataUri()
    a.volume = 0
    void a.play().then(() => a.pause()).catch(() => undefined)
  } catch {
    // 个别浏览器对静音解锁不支持，忽略：音乐仍可能正常（手势已解锁）
  }
}

/**
 * 注册播放队列清空时的一次性回调，返回取消函数。
 * 队列本来就空时立即执行；tts.start / 新一轮说话时应主动取消上一轮的等待。
 */
export function onPlaybackIdle(fn: () => void): () => void {
  if (activeSources.size === 0) {
    fn()
    return () => {}
  }
  idleListeners.add(fn)
  return () => {
    idleListeners.delete(fn)
  }
}

export function isH5AudioSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.AudioContext !== 'undefined'
  )
}

function createContext(sampleRate?: number): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('当前浏览器不支持 WebAudio')
  return sampleRate ? new Ctor({ sampleRate }) : new Ctor()
}

/**
 * 采集：持续上行每一帧（含静音）。
 *
 * 以前靠客户端能量门限过滤静音，网关只能看到「有声段」，于是分不清
 * 「用户停顿」和「麦克风断流」；现在把判定交给网关的 VAD，静音也照样发，
 * 网关才能用自适应噪声底算出句末。16k/16bit/单声道约 32KB/s，本机链路可忽略。
 */
export async function startCapture(onChunk: ChunkHandler): Promise<void> {
  if (captureCtx) return
  // 真实用户手势同步调用栈内：提前解锁 H5 自动播放，避免后续媒体/语音播放被浏览器拦截
  primeAudioAutoplay()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  markMicGranted()
  const ctx = createContext(16000)
  if (ctx.state === 'suspended') await ctx.resume()

  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0)
    onChunk(floatToPcm16(input).buffer as ArrayBuffer)
  }

  source.connect(processor)
  // 直接连到 destination：processor 不写输出（静音），既不会有回声，又能被音频图持续拉取、
  // 保证 onaudioprocess 触发。之前中间串一个 gain=0 的静音节点，Chrome 会把这个静音子图优化掉，
  // 导致 processor 不再被拉取、收不到任何音频帧（表现为「无实时识别文字 / 无法唤醒」）。
  processor.connect(ctx.destination)

  captureCtx = ctx
  captureStream = stream
  captureSource = source
  captureProcessor = processor
}

export function stopCapture(): void {
  if (captureProcessor) captureProcessor.onaudioprocess = null
  captureProcessor?.disconnect()
  captureSource?.disconnect()
  captureStream?.getTracks().forEach((track) => track.stop())
  void captureCtx?.close()
  captureCtx = null
  captureStream = null
  captureSource = null
  captureProcessor = null
}

/** 播放一段 16bit PCM；按到达顺序首尾相接，避免重叠或断裂。 */
export function playPcm(pcm: ArrayBuffer, sampleRate = 24000): void {
  if (!playCtx) {
    playCtx = createContext()
    if (playCtx.state === 'suspended') void playCtx.resume()
  }
  const ctx = playCtx
  const samples = new Int16Array(pcm)
  if (samples.length === 0) return
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i] / 32768

  const buffer = ctx.createBuffer(1, floats.length, sampleRate)
  buffer.copyToChannel(floats, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)

  const startAt = Math.max(ctx.currentTime, nextStart)
  source.start(startAt)
  nextStart = startAt + buffer.duration
  activeSources.add(source)
  source.onended = () => {
    activeSources.delete(source)
    emitIfIdle()
  }
}

/** 新一轮 TTS 开始前清空队列，避免旧音频拖尾。 */
export function resetPlayback(): void {
  activeSources.forEach((source) => {
    try {
      source.stop()
    } catch {
      // 已结束的 source 忽略
    }
  })
  activeSources.clear()
  nextStart = 0
  // stop() 的 onended 不保证触发，主动解除等待避免状态永远挂起
  emitIfIdle()
}

export function stopPlayback(): void {
  resetPlayback()
  void playCtx?.close()
  playCtx = null
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}
