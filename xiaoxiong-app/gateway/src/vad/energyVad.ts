/**
 * 能量 VAD：用自适应噪声底判断「有人说话 / 静音」。
 *
 * 客户端改成持续上行后，网关每 256ms 都会收到一帧（含静音），于是句末判定
 * 不再依赖「收不到数据」，而是靠这里逐帧给出的语音/静音结论。
 *
 * 固定阈值在真实环境里必然失效：安静房间底噪 0.002，嘈杂环境 0.03，
 * 同一个门限不是永远触发就是永远不触发。这里改成跟着底噪走：
 * 只在「本帧没被判成语音」时更新噪声底，安静时快速下探、变吵时缓慢上抬，
 * 避免把一句话的起始音量当成新底噪。
 *
 * 助手正在播报时要更保守（strict）：麦克风里会有自己的回声残留，
 * 门槛加倍并要求更长的连续人声，否则助手会被自己的声音打断。
 */

export interface VadOptions {
  /** 上行采样率，仅用于把毫秒换算成字节预算 */
  sampleRate?: number
  /** 语音门限 = 自适应底噪 × 倍数 */
  noiseMultiplier?: number
  /** 绝对下限：底噪极低时也要有最小门限，避免放大底噪后误触发 */
  minThreshold?: number
  /** 连续多少帧超过门限才确认说话开始（抑制关门、碰麦这类单帧尖峰） */
  startFrames?: number
  /** 语音结束后继续喂给 ASR 的时长，避免吞掉尾音 */
  hangoverMs?: number
  /** 说话开始前保留的音频时长，确认后整段补喂，避免吞掉首字 */
  prerollMs?: number
  /** 底噪上抬速率（每帧向当前能量靠拢的比例） */
  riseRate?: number
  /** 底噪下探速率，比上抬快，安静下来能立刻恢复灵敏度 */
  fallRate?: number
}

export interface VadPushOptions {
  /** 当前时间，测试用；默认 Date.now() */
  now?: number
  /** 播报期间的人声判定：门槛加倍、要求更多连续帧 */
  strict?: boolean
}

export interface VadResult {
  /** 本帧是否属于当前这句话（含尾音保留），决定是否喂给 ASR */
  speech: boolean
  /** 本帧是否真的有人声，决定是否重置句末计时 */
  voiced: boolean
  /** 本帧是否刚确认了一句新话的开头（用于打断上一轮回复） */
  started: boolean
  /** 需要喂给 ASR 的帧；说话确认时含前置缓冲，其余情况最多一帧 */
  frames: Uint8Array[]
}

const DEFAULTS = {
  sampleRate: 16000,
  noiseMultiplier: 3,
  minThreshold: 0.008,
  startFrames: 2,
  hangoverMs: 300,
  prerollMs: 600,
  riseRate: 0.05,
  fallRate: 0.3,
}

/** strict 模式的门槛倍数与连续帧要求。 */
const STRICT_MULTIPLIER = 2
const STRICT_START_FACTOR = 2

/** 底噪允许区间：下限防止归零后过度灵敏，上限防止持续噪声把门限顶到天上。 */
const NOISE_FLOOR_MIN = 0.0005
const NOISE_FLOOR_MAX = 0.08

export class EnergyVad {
  private readonly sampleRate: number
  private readonly noiseMultiplier: number
  private readonly minThreshold: number
  private readonly startFrames: number
  private readonly hangoverMs: number
  private readonly prerollBytes: number
  private readonly riseRate: number
  private readonly fallRate: number

  private noise = 0.008
  private inSpeech = false
  private voicedRun = 0
  private lastVoicedAt = 0
  private preroll: Uint8Array[] = []
  private prerollSize = 0

  constructor(options: VadOptions = {}) {
    this.sampleRate = options.sampleRate ?? DEFAULTS.sampleRate
    this.noiseMultiplier = options.noiseMultiplier ?? DEFAULTS.noiseMultiplier
    this.minThreshold = options.minThreshold ?? DEFAULTS.minThreshold
    this.startFrames = Math.max(1, options.startFrames ?? DEFAULTS.startFrames)
    this.hangoverMs = options.hangoverMs ?? DEFAULTS.hangoverMs
    this.prerollBytes = Math.round(
      ((options.prerollMs ?? DEFAULTS.prerollMs) * this.sampleRate * 2) / 1000
    )
    this.riseRate = options.riseRate ?? DEFAULTS.riseRate
    this.fallRate = options.fallRate ?? DEFAULTS.fallRate
  }

  /** 当前自适应底噪，便于调参与测试观察。 */
  get noiseFloor(): number {
    return this.noise
  }

  /** 当前门限（底噪 × 倍数，不低于绝对下限）。 */
  get threshold(): number {
    return Math.max(this.minThreshold, this.noise * this.noiseMultiplier)
  }

  /** 当前是否处在一句话里（含尾音保留）。 */
  get speaking(): boolean {
    return this.inSpeech
  }

  push(chunk: Uint8Array, options: VadPushOptions = {}): VadResult {
    const now = options.now ?? Date.now()
    const strict = options.strict === true
    const rms = computeRms(chunk)
    const threshold = this.threshold * (strict ? STRICT_MULTIPLIER : 1)
    const neededFrames = strict ? this.startFrames * STRICT_START_FACTOR : this.startFrames
    const voiced = rms >= threshold

    if (!this.inSpeech) {
      this.remember(chunk)
      if (voiced) {
        this.voicedRun += 1
        // 单帧尖峰先不下结论，等下一帧确认；这期间音频仍在前置缓冲里不会丢
        if (this.voicedRun < neededFrames) return SILENT
        this.inSpeech = true
        this.lastVoicedAt = now
        const frames = this.preroll
        this.preroll = []
        this.prerollSize = 0
        return { speech: true, voiced: true, started: true, frames }
      }
      this.voicedRun = 0
      this.adapt(rms)
      return SILENT
    }

    if (voiced) {
      this.lastVoicedAt = now
      return { speech: true, voiced: true, started: false, frames: [chunk] }
    }
    if (now - this.lastVoicedAt < this.hangoverMs) {
      return { speech: true, voiced: false, started: false, frames: [chunk] }
    }
    // 这句话结束，当前帧转为下一句的前置缓冲
    this.inSpeech = false
    this.voicedRun = 0
    this.remember(chunk)
    this.adapt(rms)
    return SILENT
  }

  reset(): void {
    this.inSpeech = false
    this.voicedRun = 0
    this.lastVoicedAt = 0
    this.preroll = []
    this.prerollSize = 0
  }

  /** 只在静音帧上更新底噪：语音帧会把底噪抬高，导致后面越判越迟钝。 */
  private adapt(rms: number): void {
    const rate = rms < this.noise ? this.fallRate : this.riseRate
    const next = this.noise + (rms - this.noise) * rate
    this.noise = Math.min(NOISE_FLOOR_MAX, Math.max(NOISE_FLOOR_MIN, next))
  }

  /** 前置缓冲按字节封顶，超出就丢最旧的帧。 */
  private remember(chunk: Uint8Array): void {
    if (this.prerollBytes <= 0) return
    this.preroll.push(chunk)
    this.prerollSize += chunk.byteLength
    while (this.prerollSize > this.prerollBytes && this.preroll.length > 1) {
      const dropped = this.preroll.shift()
      this.prerollSize -= dropped ? dropped.byteLength : 0
    }
  }
}

const SILENT: VadResult = { speech: false, voiced: false, started: false, frames: [] }

/** 16bit 单声道 PCM 的均方根能量，归一化到 0~1。 */
function computeRms(chunk: Uint8Array): number {
  const samples = Math.floor(chunk.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const value = view.getInt16(i * 2, true) / 32768
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}
