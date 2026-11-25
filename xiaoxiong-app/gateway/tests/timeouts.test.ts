import { describe, it, expect } from 'vitest'
import { TIMEOUT_DEFAULTS, TIMEOUT_RANGES, resolveSessionTimeouts } from '../src/timeouts'

describe('resolveSessionTimeouts：客户端下发的时间预算收敛', () => {
  it('未下发时全部取默认值', () => {
    const t = resolveSessionTimeouts()
    expect(t).toEqual({
      asrFinalizeMs: TIMEOUT_DEFAULTS.asrFinalizeMs,
      asrPartialIntervalMs: TIMEOUT_DEFAULTS.asrPartialIntervalMs,
      asrPartialMs: TIMEOUT_DEFAULTS.asrPartialMs,
      llmMs: TIMEOUT_DEFAULTS.llmMs,
      ttsMs: TIMEOUT_DEFAULTS.ttsMs,
      ttsFrameGapMs: TIMEOUT_DEFAULTS.ttsFrameGapMs,
    })
  })

  it('下发合法值时原样生效（设置页改大定稿超时能真的变大）', () => {
    const t = resolveSessionTimeouts({ asrFinalizeMs: 20000, llmMs: 30000, ttsMs: 40000, ttsFrameGapMs: 60000, asrPartialIntervalMs: 1000 })
    expect(t.asrFinalizeMs).toBe(20000)
    expect(t.llmMs).toBe(30000)
    expect(t.ttsMs).toBe(40000)
    expect(t.ttsFrameGapMs).toBe(60000)
    expect(t.asrPartialIntervalMs).toBe(1000)
  })

  it('越界值收敛到边界，非法值回落到默认——填错也不会把链路搞死', () => {
    const t = resolveSessionTimeouts({
      asrFinalizeMs: 999999,
      llmMs: 1,
      ttsMs: Number.NaN,
      ttsFrameGapMs: -5,
      asrPartialIntervalMs: 'abc' as unknown as number,
    })
    expect(t.asrFinalizeMs).toBe(TIMEOUT_RANGES.asrFinalizeMs[1])
    expect(t.llmMs).toBe(TIMEOUT_RANGES.llmMs[0])
    expect(t.ttsMs).toBe(TIMEOUT_DEFAULTS.ttsMs)
    expect(t.ttsFrameGapMs).toBe(TIMEOUT_DEFAULTS.ttsFrameGapMs)
    expect(t.asrPartialIntervalMs).toBe(TIMEOUT_DEFAULTS.asrPartialIntervalMs)
  })

  it('中间识别超时不对用户暴露，恒取默认值', () => {
    const t = resolveSessionTimeouts({ asrFinalizeMs: 20000 })
    expect(t.asrPartialMs).toBe(TIMEOUT_DEFAULTS.asrPartialMs)
  })
})
