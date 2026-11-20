import { duckMusic } from './musicPlayer'
import { appPlayCue, isAppCueSupported } from './appCue'

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
  /** 识别失败/超时的运行中瞬时提示（建连 health 不覆盖）：「没听清，再说一遍」 */
  | 'asrError'
  /** 思考超时的安抚提示：「稍等一下，我还在想」 */
  | 'thinking'
  /** 插话队列已满：「你说的太多了，我记不住」 */
  | 'queueFull'
  /** 网关启动中 / 已就绪：避免用户在这段时间喊唤醒词没反应以为坏了 */
  | 'gatewayPreparing'
  | 'gatewayReady'
  /** 运行中 LLM 生成失败 / TTS 播报失败：用本地 mp3 兜底（TTS 本身坏了时不能再靠 TTS 念兜底） */
  | 'llmError'
  | 'ttsError'

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
  asrError: 'asr-error',
  thinking: 'thinking',
  queueFull: 'queue-full',
  gatewayPreparing: 'gateway-preparing',
  gatewayReady: 'gateway-ready',
  llmError: 'llm-error',
  ttsError: 'tts-error',
}

/** 提示音全部走客户端打包内的本地文件（/static/audio/，唯一一份，mp3 不在网关侧再放副本）：
 * 断网 / 网关异常 / App 离线时提示音照样能出声（原生 playCue 从 apk assets 直接读）。 */

/** 临时排查埋点：把提示音链路事件暴露给 UI（useAssistant 注册 sink，显示到行内错误条）。 */
let cueDebugSink: ((msg: string) => void) | null = null
export function setCueDebugSink(fn: ((msg: string) => void) | null): void {
  cueDebugSink = fn
}
function cueDebug(msg: string): void {
  console.log('[cue]', msg)
  try {
    cueDebugSink?.(msg)
  } catch {
    // sink 异常不影响播放
  }
}

/** 打包内的本地文件地址（App / H5 同路径），作为网关拉取失败时的兜底。 */
function bundledCueUrl(cue: PromptCue): string {
  return `/static/audio/${CUE_FILE[cue]}.mp3`
}

/** 提示音实际地址：全部走打包内本地文件（唯一一份），App 端原生 playCue 从 apk assets 直读、
 * H5 走同路径；能力不可用提示更不该依赖网关 HTTP（网关刚挂时正是要播的时候）。 */
function cueUrl(cue: PromptCue): string {
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
  // 时长经 9529 重新生成后实测（edge-tts XiaoxiaoNeural），留约 200ms 尾音余量：
  // asr-error 3.79s / thinking 2.64s / queue-full 2.83s
  asrError: 4000,
  thinking: 2850,
  queueFull: 3050,
  // gateway-preparing 2.83s / gateway-ready 1.80s / llm-error 3.46s / tts-error 3.43s
  gatewayPreparing: 3050,
  gatewayReady: 2000,
  llmError: 3700,
  ttsError: 3650,
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
    // 本地文件播放失败：仍失败才用合成音
    try {
      const f = new Audio(bundledCueUrl(cue))
      const r = f.play()
      if (r && typeof r.catch === 'function') r.catch(() => playWebAudioCue(cue))
    } catch {
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
    audio.onEnded(() => {
      cueDebug(`播放完成: ${cue}`)
      cleanup()
    })
    audio.onError(() => {
      cueDebug(`播放失败: ${cue} src=${src}`)
      cleanup()
      if (onFail) onFail()
    })
    audio.play()
    cueDebug(`开始播放: ${cue} src=${src}`)
  } catch {
    cueDebug(`播放异常(同步): ${cue}`)
    cleanup()
    if (onFail) onFail()
  }
  // 兜底销毁：提示音本身时长 + 1.5s 余量；即便回调丢失也在此后强制回收。
  timer = setTimeout(cleanup, CUE_MUTE_MS[cue] + 1500)
}

/** 当前提示音 duck 的恢复句柄：新提示音开始前先恢复上一次，避免多个提示音叠加把音乐一直压着。 */
let undoCueDuck: (() => void) | null = null

/**
 * 提示音期间压低音乐（对标 H5 ducking），播完/超时恢复。用 once 保护：原生 onCueEnd
 * 与兜底定时器可能都触发，只恢复一次。与 TTS 的 duck 阶段互斥（提示音在唤醒/待唤醒，
 * TTS 在回答），故各自独立管理，不做全局引用计数。
 */
function duckForCue(cue: PromptCue): () => void {
  undoCueDuck?.()
  duckMusic(true)
  let done = false
  const restore = (): void => {
    if (done) return
    done = true
    if (undoCueDuck === restore) undoCueDuck = null
    duckMusic(false)
  }
  undoCueDuck = restore
  // 兜底：原生 onCueEnd 丢失时按时长恢复，避免音乐被一直压着
  setTimeout(restore, CUE_MUTE_MS[cue] + 800)
  return restore
}

/**
 * App 端播放提示音。
 * 优先走原生 MediaPlayer（不申请音频焦点）——不会抢走音乐的焦点、把音乐 pause；
 * 播放期间 duckMusic(true)、播完恢复。失败/旧基座不支持时降级回 InnerAudioContext
 * （那条路底层 AudioPlayer 会 requestAudioFocus，会打断音乐，但至少能出声）。
 */
function playAppCue(cue: PromptCue): void {
  // 打包内文件：App 端所有提示音都走本地文件（cueUrl 在 #ifndef H5 下恒为 bundledCueUrl）
  const file = CUE_FILE[cue] + '.mp3'
  if (isAppCueSupported()) {
    const restore = duckForCue(cue)
    const played = appPlayCue(file, (completed) => {
      cueDebug(`原生提示音结束: ${cue} completed=${completed}`)
      restore()
    })
    if (played) return
    // 原生调用本身失败：撤销 duck，走降级
    restore()
  }
  const src = cueUrl(cue)
  playOneCue(cue, src, () => {
    // 本地文件播放失败：重试一次本地路径，仍不阻断状态机
    playOneCue(cue, bundledCueUrl(cue))
  })
}

// #endif
