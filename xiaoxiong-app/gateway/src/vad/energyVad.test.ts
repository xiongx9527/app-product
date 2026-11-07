import { describe, it, expect } from 'vitest'
import { EnergyVad } from './energyVad'

/** 生成 rms≈amplitude 的方波帧（16k/16bit/mono，100ms）。 */
function frame(amplitude: number, samples = 1600): Uint8Array {
  const pcm = new Int16Array(samples)
  const value = Math.round(amplitude * 32768)
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 2 === 0 ? value : -value
  return new Uint8Array(pcm.buffer)
}

describe('EnergyVad 自适应噪声底', () => {
  it('纯静音不判为语音，底噪会继续下探', () => {
    const vad = new EnergyVad()
    const before = vad.noiseFloor
    for (let i = 0; i < 10; i += 1) {
      const result = vad.push(frame(0.0005), { now: i * 100 })
      expect(result.speech).toBe(false)
      expect(result.voiced).toBe(false)
    }
    expect(vad.noiseFloor).toBeLessThan(before)
  })

  it('连续两帧人声才确认开口，前置缓冲一并补喂', () => {
    const vad = new EnergyVad()
    const first = frame(0.2)
    const second = frame(0.2)

    const one = vad.push(first, { now: 0 })
    expect(one.started).toBe(false)
    expect(one.frames).toHaveLength(0)

    const two = vad.push(second, { now: 100 })
    expect(two.started).toBe(true)
    expect(two.voiced).toBe(true)
    // 第一帧不能丢：它在前置缓冲里，确认开口时整段补喂
    expect(two.frames).toHaveLength(2)
    expect(two.frames[0]).toBe(first)
    expect(two.frames[1]).toBe(second)
  })

  it('尾音保留期内继续喂帧，但不再重置句末计时', () => {
    const vad = new EnergyVad({ hangoverMs: 300 })
    vad.push(frame(0.2), { now: 0 })
    vad.push(frame(0.2), { now: 100 })

    const tail = vad.push(frame(0.0005), { now: 200 })
    expect(tail.speech).toBe(true)
    expect(tail.voiced).toBe(false)

    const ended = vad.push(frame(0.0005), { now: 600 })
    expect(ended.speech).toBe(false)
    expect(vad.speaking).toBe(false)
  })

  it('环境变吵后门限跟着抬高，同等能量不再误判为人声', () => {
    const vad = new EnergyVad()
    const quietThreshold = vad.threshold

    // 持续的中等噪声（低于初始门限，所以只用来抬底噪，不算说话）
    for (let i = 0; i < 80; i += 1) vad.push(frame(0.02), { now: i * 100 })

    expect(vad.noiseFloor).toBeGreaterThan(0.015)
    expect(vad.threshold).toBeGreaterThan(quietThreshold)
    // 原来会被判成语音的能量，现在低于新门限
    expect(vad.push(frame(0.04), { now: 9000 }).voiced).toBe(false)
  })

  it('播报期间用 strict 门槛：需要更多连续帧才认打断', () => {
    const vad = new EnergyVad()
    const a = vad.push(frame(0.3), { now: 0, strict: true })
    const b = vad.push(frame(0.3), { now: 100, strict: true })
    expect(a.started).toBe(false)
    expect(b.started).toBe(false)

    const c = vad.push(frame(0.3), { now: 200, strict: true })
    const d = vad.push(frame(0.3), { now: 300, strict: true })
    expect(c.started).toBe(false)
    expect(d.started).toBe(true)
  })

  it('句中短停顿（默认 hangoverMs=800）不结束当前句，避免被切断', () => {
    // 用户中途思考停顿：停顿 500ms 不应被当成"说完了"，整句仍是同一段。
    const vad = new EnergyVad() // 默认 hangoverMs = 800
    vad.push(frame(0.2), { now: 0 })
    vad.push(frame(0.2), { now: 100 })
    expect(vad.speaking).toBe(true)

    // 静音 500ms（< 800）：仍在同一句里
    const pause = vad.push(frame(0.0005), { now: 600 })
    expect(pause.speech).toBe(true)
    expect(pause.voiced).toBe(false)
    expect(vad.speaking).toBe(true)

    // 继续说话，句仍连续（不会因刚才的停顿被切成两段）
    const resume = vad.push(frame(0.2), { now: 700 })
    expect(resume.speech).toBe(true)
    expect(vad.speaking).toBe(true)

    // 只有静音超过 800ms 才真正结束当前句
    const ended = vad.push(frame(0.0005), { now: 1600 })
    expect(ended.speech).toBe(false)
    expect(vad.speaking).toBe(false)
  })
})
