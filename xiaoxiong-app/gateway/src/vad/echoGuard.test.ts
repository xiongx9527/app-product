import { describe, it, expect } from 'vitest'
import { EchoGuard } from './echoGuard'

describe('EchoGuard 回声兜底', () => {
  it('紧跟播报的打断连续命中后进入半双工，冷却结束自动恢复', () => {
    const guard = new EchoGuard({ windowMs: 1000, strikes: 2, cooldownMs: 5000 })

    guard.onDownlink(1000)
    guard.noteBargeIn(1200)
    expect(guard.muted(1200)).toBe(false)

    guard.onDownlink(2000)
    guard.noteBargeIn(2200)
    expect(guard.muted(2200)).toBe(true)

    expect(guard.muted(7199)).toBe(true)
    expect(guard.muted(7201)).toBe(false)
  })

  it('安静时的打断说明是真人，不计入可疑次数', () => {
    const guard = new EchoGuard({ windowMs: 500, strikes: 2, cooldownMs: 5000 })
    guard.onDownlink(0)
    guard.noteBargeIn(3000)
    guard.onDownlink(4000)
    guard.noteBargeIn(6000)
    expect(guard.muted(6000)).toBe(false)
  })

  it('手动打断立即解除兜底', () => {
    const guard = new EchoGuard({ windowMs: 1000, strikes: 1, cooldownMs: 5000 })
    guard.onDownlink(0)
    guard.noteBargeIn(100)
    expect(guard.muted(100)).toBe(true)

    guard.release()
    expect(guard.muted(100)).toBe(false)
  })
})
