export type PromptCue = 'greeting' | 'stillThere' | 'farewell'

const CUE_FILE: Record<PromptCue, string> = {
  greeting: 'greeting',
  stillThere: 'still-there',
  farewell: 'farewell',
}

/** 本地提示音经扬声器外放会被麦克风收回，这段时间内上行必须静音，否则会自激。
 *  数值按 static/audio 下 mp3 实测时长（1.22s / 1.42s / 3.14s）留一点尾音余量。 */
const CUE_MUTE_MS: Record<PromptCue, number> = {
  greeting: 1400,
  stillThere: 1700,
  farewell: 3400,
}

let cueMuteUntil = 0

/** 当前是否正在播本地提示音：采集回调据此把上行帧清零。 */
export function isPromptCuePlaying(): boolean {
  return Date.now() < cueMuteUntil
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

// #ifdef H5
/** H5 优先播放本地 mp3（与 App 同音色），被浏览器拦截或缺失时回退到合成音。 */
function playHtmlAudioCue(cue: PromptCue): void {
  try {
    const audio = new Audio(`/static/audio/${CUE_FILE[cue]}.mp3`)
    const result = audio.play()
    if (result && typeof result.catch === 'function') {
      result.catch(() => playWebAudioCue(cue))
    }
  } catch {
    playWebAudioCue(cue)
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
function playAppCue(cue: PromptCue): void {
  try {
    const audio = uni.createInnerAudioContext()
    audio.src = `/static/audio/${CUE_FILE[cue]}.mp3`
    audio.onEnded(() => audio.destroy())
    audio.onError(() => audio.destroy())
    audio.play()
  } catch {
    // 文件缺失时不阻断状态机
  }
}
// #endif
