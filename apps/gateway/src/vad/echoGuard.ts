/**
 * AEC 失效兜底：连续「播报中被打断」说明打断源不是人，而是扬声器回声。
 *
 * 浏览器给的 echoCancellation 并不总是有效（外放、耳机漏音、系统混音都会让它失效）。
 * 一旦失效，表现是一条死循环：助手说话 → 麦克风收到自己的声音 → 判定用户插话 →
 * 打断自己 → 重新回答 → 再次被打断。这里用熔断的方式兜住：
 * 紧跟在 TTS 下发之后的打断记为一次「可疑回声打断」，连续命中就降级成半双工——
 * 播报期间直接忽略上行，用户改用「打断」按钮；冷却结束后自动恢复。
 */

export interface EchoGuardOptions {
  /** 打断发生在最后一次 TTS 下发后多久内，算「紧跟播报」 */
  windowMs?: number
  /** 连续多少次可疑打断后降级 */
  strikes?: number
  /** 降级持续时间，超时自动恢复，避免一直哑着 */
  cooldownMs?: number
}

const DEFAULTS = {
  windowMs: 2000,
  strikes: 2,
  cooldownMs: 8000,
}

export class EchoGuard {
  private readonly windowMs: number
  private readonly maxStrikes: number
  private readonly cooldownMs: number

  private lastDownlinkAt = 0
  private strikes = 0
  private mutedUntil = 0

  constructor(options: EchoGuardOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs
    this.maxStrikes = Math.max(1, options.strikes ?? DEFAULTS.strikes)
    this.cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs
  }

  /** 网关每下发一帧 TTS 音频时调用，用于判断打断是否紧跟播报。 */
  onDownlink(now = Date.now()): void {
    this.lastDownlinkAt = now
  }

  /** 当前是否处于半双工兜底（播报期间忽略上行）。 */
  muted(now = Date.now()): boolean {
    return now < this.mutedUntil
  }

  /** 记录一次打断；紧跟播报的才算可疑回声，安静时的打断说明是真人，清零。 */
  noteBargeIn(now = Date.now()): void {
    if (now - this.lastDownlinkAt > this.windowMs) {
      this.strikes = 0
      return
    }
    this.strikes += 1
    if (this.strikes >= this.maxStrikes) {
      this.strikes = 0
      this.mutedUntil = now + this.cooldownMs
    }
  }

  /** 用户手动打断：证明是真人操作，立即解除兜底。 */
  release(): void {
    this.strikes = 0
    this.mutedUntil = 0
  }
}
