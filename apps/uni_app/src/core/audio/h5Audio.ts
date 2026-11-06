/**
 * H5 端音频：麦克风采集为 16k/16bit/单声道 PCM 上行，TTS 24k PCM 下行顺序播放。
 * 仅 H5 使用；App 端走 uni.getRecorderManager / innerAudioContext（后续实现）。
 */

type ChunkHandler = (pcm: ArrayBuffer) => void

let captureCtx: AudioContext | null = null
let captureStream: MediaStream | null = null
let captureSource: MediaStreamAudioSourceNode | null = null
let captureProcessor: ScriptProcessorNode | null = null
let captureMute: GainNode | null = null

let playCtx: AudioContext | null = null
let nextStart = 0
const activeSources = new Set<AudioBufferSourceNode>()

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

/** 采集：能量高于门限才回调，静默时不上行，网关据此在 700ms 后判定句末。 */
export async function startCapture(onChunk: ChunkHandler, minRms = 0.012): Promise<void> {
  if (captureCtx) return
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const ctx = createContext(16000)
  if (ctx.state === 'suspended') await ctx.resume()

  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0)
    let sum = 0
    for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i]
    const rms = Math.sqrt(sum / input.length)
    if (rms < minRms) return
    onChunk(floatToPcm16(input).buffer as ArrayBuffer)
  }

  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  captureCtx = ctx
  captureStream = stream
  captureSource = source
  captureProcessor = processor
  captureMute = mute
}

export function stopCapture(): void {
  if (captureProcessor) captureProcessor.onaudioprocess = null
  captureProcessor?.disconnect()
  captureSource?.disconnect()
  captureMute?.disconnect()
  captureStream?.getTracks().forEach((track) => track.stop())
  void captureCtx?.close()
  captureCtx = null
  captureStream = null
  captureSource = null
  captureProcessor = null
  captureMute = null
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
  source.onended = () => activeSources.delete(source)
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
