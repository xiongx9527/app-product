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

/** 同一提示音去重窗口（ms）：窗口内重复触发只播一次，规避唤醒词被多路命中导致的「放两遍」。 */
const CUE_DEDUP_MS = 1000
/** 上一次实际播放的提示音与时刻，用于去重判断。 */
let lastCuePlayed: PromptCue | null = null
let lastCuePlayedAt = 0

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

  // 去重：同一提示音 1s 内只播一次。唤醒词常被网关经 asr.partial 与 asr.final
  // 先后各命中一次，且两条消息到达的间隙里状态机可能还没翻成 listening，导致
  // playGreeting / playPrompt 连续触发两次，听感就是「我在 / 还在吗 放两遍」。
  // 正常场景里任何提示音都不需要在 1s 内连播两遍，去重即可消除该现象且不误伤
  // 正常的不同提示音序列（健康播报等走不同 cue，队列本身也间隔 ≥1.4s）。
  const now = Date.now()
  if (cue === lastCuePlayed && now - lastCuePlayedAt < CUE_DEDUP_MS) return
  lastCuePlayed = cue
  lastCuePlayedAt = now

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
/** H5 优先播放提示音；网关类提示从网关拉取，失败回退打包内文件，再不行才用合成音兜底。
 *  关键：兜底（playWebAudioCue / 回退本地文件）必须「只跑一次」。浏览器里 mp3 加载失败时，
 *  <audio>.play() 的 rejected promise 与元素的 error 事件可能都触发，若各自兜底会合成两次
 *  （听感就是「我在 / 我在」放两遍）。用 handled 标记收敛成一次性动作。 */
function playHtmlAudioCue(cue: PromptCue): void {
  let handled = false
  const fallback = (): void => {
    if (handled) return
    handled = true
    if (isGatewayCue(cue) && cueUrl(cue) !== bundledCueUrl(cue)) {
      // 网关拉取失败：回退到打包内本地文件，仍失败才用合成音
      try {
        const f = new Audio(bundledCueUrl(cue))
        const r = f.play()
        if (r && typeof r.catch === 'function') r.catch(() => playWebAudioCue(cue))
      } catch {
        playWebAudioCue(cue)
      }
    } else {
      playWebAudioCue(cue)
    }
  }
  try {
    const audio = new Audio(cueUrl(cue))
    audio.addEventListener('error', fallback)
    const result = audio.play()
    if (result && typeof result.catch === 'function') {
      result.catch(fallback)
    }
  } catch {
    fallback()
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
/**
 * 播放一个本地/网关音频对象，并保证它一定会被销毁：正常播完（onEnded）或出错（onError）
 * 都销毁；再额外加一个基于该提示音时长的兜底定时器，万一 App 端 onEnded/onError 都没回调
 * （某些机型上音频对象静默失败时两个回调都不触发），也能在超时后销毁，避免泄漏累积。
 * 泄漏的音频对象会在原生音频层继续播放、且 webview 刷新后也关不掉（用户反馈的
 * 「放两遍 / 关不掉 / 刷新后还在放」正是它导致的）。
 */
function playOneCue(cue: PromptCue, src: string, onFail?: () => void): void {
  let audio: UniApp.InnerAudioContext | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!audio) return
    try {
      audio.destroy()
    } catch {
      // 已销毁，忽略
    }
    audio = null
  }
  try {
    audio = uni.createInnerAudioContext()
    audio.src = src
    audio.onEnded(cleanup)
    audio.onError(() => {
      cleanup()
      if (onFail) onFail()
    })
    audio.play()
  } catch {
    cleanup()
    if (onFail) onFail()
  }
  // 兜底销毁：提示音本身时长 + 1.5s 余量；即便回调丢失也在此后强制回收。
  timer = setTimeout(cleanup, CUE_MUTE_MS[cue] + 1500)
}

/** App 端播放提示音：网关类提示从网关 HTTP 拉取，失败（网关挂了 / 拉取异常）回退打包内文件。 */
function playAppCue(cue: PromptCue): void {
  const src = cueUrl(cue)
  playOneCue(cue, src, () => {
    if (isGatewayCue(cue) && src !== bundledCueUrl(cue)) {
      // 网关拉取失败：状态类提示回退到打包内本地文件，仍不阻断状态机
      playOneCue(cue, bundledCueUrl(cue))
    }
  })
}

// #endif
