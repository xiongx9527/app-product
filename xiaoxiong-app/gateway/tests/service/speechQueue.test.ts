import { describe, it, expect } from 'vitest'
import { SpeechQueue } from '../../src/service/voiceSessionService'

const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
type Result = { frames: Uint8Array[] }
const ok = (): Result => ({ frames: [] })

/** 并行合成 + 按断句顺序下发：后句先完成也不抢播。 */
describe('SpeechQueue：并行合成 + 按序下发', () => {
  it('push 即启动合成，不等 drain（首字不延迟）', async () => {
    const started: number[] = []
    const d = deferred<Result>()
    const q = new SpeechQueue((_text, idx) => { started.push(idx); return d.promise }, () => {})
    q.push('第一句。')
    expect(started).toEqual([0])
    d.resolve(ok())
    await q.drain()
  })

  it('后句先合成完仍按入队顺序下发（先合成的先播，不能先完成的播）', async () => {
    const played: number[] = []
    const ds = [deferred<Result>(), deferred<Result>(), deferred<Result>()]
    const q = new SpeechQueue(
      (_text, idx) => ds[idx].promise,
      (_result, idx) => { played.push(idx) },
    )
    q.push('1'); q.push('2'); q.push('3')
    // 倒序完成：2 → 1 → 0
    ds[2].resolve(ok())
    ds[1].resolve(ok())
    ds[0].resolve(ok())
    await q.drain()
    // 下发仍严格按入队顺序
    expect(played).toEqual([0, 1, 2])
  })

  it('并发上限生效：最多 N 句同时合成，完成一个补一个', async () => {
    let active = 0
    let max = 0
    const ds = Array.from({ length: 6 }, () => deferred<Result>())
    const allDs = [...ds]
    const q = new SpeechQueue(
      async () => {
        active += 1
        max = Math.max(max, active)
        await ds.shift()!.promise
        active -= 1
        return ok()
      },
      () => {},
      2,
    )
    for (let i = 0; i < 6; i += 1) q.push(`句${i}`)
    expect(max).toBe(2)
    // 补位：先完成一个，第 3 句立即启动
    ds[0].resolve(ok())
    await Promise.resolve()
    await Promise.resolve()
    expect(max).toBe(2)
    allDs.forEach((d) => d.resolve(ok()))
    await q.drain()
  })

  it('abortAll 把取消信号传给所有在途合成', async () => {
    const signals: AbortSignal[] = []
    const ds = [deferred<Result>(), deferred<Result>()]
    const allDs = [...ds]
    const q = new SpeechQueue(
      (_text, _idx, signal) => { signals.push(signal); return ds.shift()!.promise },
      () => {},
    )
    q.push('1'); q.push('2')
    q.abortAll()
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s.aborted)).toBe(true)
    allDs.forEach((d) => d.resolve(ok()))
    await q.drain()
  })

  it('合成或下发抛错时 drain 不挂，hadError 置位', async () => {
    const q = new SpeechQueue(
      async () => { throw new Error('synth boom') },
      () => { throw new Error('play boom') },
    )
    q.push('1'); q.push('2')
    await q.drain()
    expect(q.hadError).toBe(true)
  })
})
