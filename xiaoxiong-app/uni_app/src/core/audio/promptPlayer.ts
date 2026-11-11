import { resolveGatewayHttpBase } from '@/core/transport'

export type PromptCue =
  | 'greeting'
  | 'stillThere'
  | 'farewell'
  | 'gatewayDown'
  | 'networkDown'
  | 'asrDown'
  | 'ttsDown'
  | 'llmDown'
  | 'micDenied'

const CUE_FILE: Record<PromptCue, string> = {
  greeting: 'greeting',
  stillThere: 'still-there',
  farewell: 'farewell',
  gatewayDown: 'gateway-down',
  networkDown: 'network-down',
  asrDown: 'asr-down',
  ttsDown: 'tts-down',
  llmDown: 'llm-down',
  micDenied: 'mic-denied',
}

/** 「能力不可用」提示由网关经 HTTP 下发（/static/cues/<file>.mp3），其余提示音走打包内的本地文件。
 * 注意：gatewayDown 故意不在此列表——网关本身连不上时不可能从网关拉取，必须直接播打包内的本地文件。 */
const GATEWAY_CUES: ReadonlyArray<PromptCue> = [
  'networkDown',
  'asrDown',
  'ttsDown',
  'llmDown',
  'micDenied',
]

function isGatewayCue(cue: PromptCue): boolean {
  return GATEWAY_CUES.includes(cue)
}

/** 打包内的本地文件地址（App / H5 同路径），作为网关拉取失败时的兜底。 */
function bundledCueUrl(cue: PromptCue): string {
  return `/static/audio/${CUE_FILE[cue]}.mp3`
}

/** 提示音实际地址：网关类提示走网关 HTTP（与助手说话同链路、同音色），其余走本地打包。 */
function cueUrl(cue: PromptCue): string {
  if (isGatewayCue(cue)) {
    return `${resolveGatewayHttpBase()}/static/cues/${CUE_FILE[cue]}.mp3`
  }
  return bundledCueUrl(cue)
}

/** 本地提示音经扬声器外放会被麦克风收回，这段时间内上行必须静音，否则会自激。
 *  数值按 static/audio 下 mp3 实测时长（greeting 1.22s / still-there 1.42s / farewell 3.14s /
 *  network-down 3.84s / asr-down 4.01s / tts-down 3.34s / llm-down 3.46s / gateway-down 3.84s /
 *  mic-denied 5.90s）留一点尾音余量。 */
const CUE_MUTE_MS: Record<PromptCue, number> = {
  greeting: 1400,
  stillThere: 1700,
  farewell: 3400,
  gatewayDown: 4100,
  networkDown: 4100,
  asrDown: 4200,
  ttsDown: 3600,
  llmDown: 3700,
  micDenied: 6200,
}

let cueMuteUntil = 0

/** 当前是否正在播本地提示音：采集回调据此把上行帧清零。 */
export function isPromptCuePlaying(): boolean {
  return Date.now() < cueMuteUntil
}

/**
 * 多条提示音共享的串行队列：网关可能在建连即一次性下发多条（如 ASR/TTS/LLM 全不可达），
 * 健康栏瞬时变化也可能补播多条；统一进队列、按各自时长串起来播，避免首尾叠音、自激或互相覆盖。
 * 单条即时提示（greeting / farewell / stillThere 等）仍走 playPromptCue 立即出声，不进队列。
 */
const cueQueue: PromptCue[] = []
let cueDraining = false

function drainCueQueue(): void {
  if (cueDraining) return
  const cue = cueQueue.shift()
  if (!cue) return
  cueDraining = true
  // 先等掉任何正在播的即时提示（如 greeting），再起播本队列首条，避免跨队列叠音
  const wait = Math.max(0, cueMuteUntil - Date.now())
  setTimeout(() => {
    playPromptCue(cue)
    // 前一条播完（含尾音余量）后才播下一条
    setTimeout(() => {
      cueDraining = false
      drainCueQueue()
    }, CUE_MUTE_MS[cue])
  }, wait)
}

/** 把一条提示音排进串行队列：用于「一次性多条」场景（能力不可达播报）。 */
export function enqueueCue(cue: PromptCue): void {
  cueQueue.push(cue)
  drainCueQueue()
}

/**
 * 唤醒招呼、退出提示都必须本地出声，断网也能用。
 * H5 用 WebAudio 生成提示音；App 用 static/audio 下的本地文件。
 */
export function playPromptCue(cue: PromptCue): void {
  cueMuteUntil = Math.max(cueMuteUntil, Date.now() + CUE_MUTE_MS[cue])

  // #ifdef H5
  playHtmlAudioCue(cue)
  // #endif

  // #ifndef H5
  playAppCue(cue)
  // #endif
  // 不弹任何文字浮层：状态由页面 hint / 阶段胶囊表达，提示音只负责出声
}

/**
 * 顺序播多条本地提示音（如唤醒后发现多个能力不可用，逐条告知）。
 * 改为走共享串行队列，与网关一次性下发的多条 client.cue 统一排程，彻底避免叠音。
 */
export function playPromptCueSequence(cues: PromptCue[]): void {
  cues.forEach((cue) => enqueueCue(cue))
}

// #ifdef H5
/** H5 优先播放提示音；网关类提示从网关拉取，失败回退打包内文件，再不行才用合成音兜底。 */
function playHtmlAudioCue(cue: PromptCue): void {
  try {
    const audio = new Audio(cueUrl(cue))
    const result = audio.play()
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        if (isGatewayCue(cue) && cueUrl(cue) !== bundledCueUrl(cue)) {
          // 网关拉取失败：回退到打包内本地文件
          try {
            const fallback = new Audio(bundledCueUrl(cue))
            void fallback.play()
          } catch {
            playWebAudioCue(cue)
          }
        } else {
          playWebAudioCue(cue)
        }
      })
    }
  } catch {
    if (isGatewayCue(cue)) {
      try {
        void new Audio(bundledCueUrl(cue)).play()
      } catch {
        /* 忽略 */
      }
    } else {
      playWebAudioCue(cue)
    }
  }
}

function playWebAudioCue(cue: PromptCue): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return

    const ctx = new Ctor()
    // 招呼用上行双音，提示与结束用单音，听感上能区分
    const notes =
      cue === 'greeting' ? [660, 880] : [cue === 'stillThere' ? 660 : 440]
    const noteGap = 0.12
    const noteLength = 0.28

    notes.forEach((frequency, index) => {
      const start = ctx.currentTime + index * noteGap
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + noteLength)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + noteLength)
    })

    const totalMs = ((notes.length - 1) * noteGap + noteLength) * 1000
    setTimeout(() => void ctx.close(), Math.ceil(totalMs) + 50)
  } catch {
    // 提示音失败不影响唤醒与退出流程
  }
}
// #endif

// #ifndef H5
/** App 端播放提示音：网关类提示从网关 HTTP 拉取，失败（网关挂了 / 拉取异常）回退打包内文件。 */
function playAppCue(cue: PromptCue): void {
  const play = (src: string): void => {
    try {
      const audio = uni.createInnerAudioContext()
      audio.src = src
      audio.onError(() => {
        audio.destroy()
        // 网关拉取失败：状态类提示回退到打包内本地文件，仍不阻断状态机
        if (isGatewayCue(cue) && src !== bundledCueUrl(cue)) {
          playBundledCue(cue)
        }
      })
      audio.onEnded(() => audio.destroy())
      audio.play()
    } catch {
      if (isGatewayCue(cue)) playBundledCue(cue)
    }
  }
  play(cueUrl(cue))
}

/** 兜底：直接播打包内的本地提示文件。 */
function playBundledCue(cue: PromptCue): void {
  try {
    const audio = uni.createInnerAudioContext()
    audio.src = bundledCueUrl(cue)
    audio.onEnded(() => audio.destroy())
    audio.onError(() => audio.destroy())
    audio.play()
  } catch {
    // 文件缺失时不阻断状态机
  }
}
// #endif
