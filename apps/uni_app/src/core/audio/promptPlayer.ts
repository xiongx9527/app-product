export type PromptCue = 'greeting' | 'stillThere' | 'farewell'

const CUE_TEXT: Record<PromptCue, string> = {
  greeting: '我在',
  stillThere: '还在吗？',
  farewell: '那我先退下了，需要时再叫我。',
}

const CUE_FILE: Record<PromptCue, string> = {
  greeting: 'greeting',
  stillThere: 'still-there',
  farewell: 'farewell',
}

/**
 * 唤醒招呼、退出提示都必须本地出声，断网也能用。
 * H5 用 WebAudio 生成提示音；App 用 static/audio 下的本地文件。
 */
export function playPromptCue(cue: PromptCue): void {
  // #ifdef H5
  playHtmlAudioCue(cue)
  // #endif

  // #ifndef H5
  playAppCue(cue)
  // #endif

  uni.showToast({
    title: CUE_TEXT[cue],
    icon: 'none',
    duration: cue === 'greeting' ? 1000 : 1500,
  })
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
