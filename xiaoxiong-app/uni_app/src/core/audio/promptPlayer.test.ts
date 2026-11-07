import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPromptCuePlaying, playPromptCue } from './promptPlayer'

describe('promptPlayer 本地提示音静音窗口', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubGlobal('uni', {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('播放提示音期间屏蔽上行，窗口结束后恢复', () => {
    expect(isPromptCuePlaying()).toBe(false)

    playPromptCue('stillThere')
    expect(isPromptCuePlaying()).toBe(true)

    vi.advanceTimersByTime(1699)
    expect(isPromptCuePlaying()).toBe(true)

    vi.advanceTimersByTime(2)
    expect(isPromptCuePlaying()).toBe(false)
  })

  it('三种提示音各有按实测时长设定的窗口', () => {
    const windows: Record<'greeting' | 'stillThere' | 'farewell', number> = {
      greeting: 1400,
      stillThere: 1700,
      farewell: 3400,
    }
    // 时间只前进不回拨，避免上一个用例的静音窗口影响下一轮
    let base = 100_000
    for (const [cue, ms] of Object.entries(windows) as [
      'greeting' | 'stillThere' | 'farewell',
      number
    ][]) {
      vi.setSystemTime(base)
      playPromptCue(cue)
      vi.advanceTimersByTime(ms - 1)
      expect(isPromptCuePlaying()).toBe(true)
      vi.advanceTimersByTime(1)
      expect(isPromptCuePlaying()).toBe(false)
      base += 10_000
    }
  })
})
