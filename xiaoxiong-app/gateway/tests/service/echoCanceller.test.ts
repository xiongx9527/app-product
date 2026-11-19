import { describe, it, expect } from 'vitest'
import { EchoCanceller } from '../../src/service/echoCanceller'

function toPcm(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}
describe('EchoCanceller', () => {
  it('实时时序下消掉 TTS 回声、保留真人声', () => {
    const ec = new EchoCanceller()
    const FRAME = 512 // 16k 每帧 32ms
    const FRAMES = 90 // ~2.9 秒
    const DELAY_FRAMES = 2 // 回声延迟 2 帧 = 64ms
    // 逐帧生成 TTS（24k），推参考；同时生成回声（延迟）+ 后半段人声，处理近端
    const ttsAt = (f: number, k: number): number =>
      (Math.sin((f * FRAME + k) * 0.07) + Math.sin((f * FRAME + k) * 0.013) * 0.6) * 0.25
    let sumBefore = 0, sumAfter = 0, cnt = 0 // 只统计前半段（纯回声，无真人声）
    const outAll: number[] = []
    for (let f = 0; f < FRAMES; f += 1) {
      // 远端参考：本帧 TTS，24k = 16k*1.5，推 768 个 24k 样本
      const tts24 = new Float32Array(FRAME * 3 / 2)
      for (let i = 0; i < tts24.length; i += 1) {
        tts24[i] = ttsAt(f, Math.min(FRAME - 1, Math.floor(i * 2 / 3)))
      }
      ec.pushReference(toPcm(tts24))
      // 近端 = 延迟 DELAY_FRAMES 帧的 TTS 回声 + 后半段真人声
      const near = new Float32Array(FRAME)
      for (let k = 0; k < FRAME; k += 1) {
        const echo = f >= DELAY_FRAMES ? ttsAt(f - DELAY_FRAMES, k) * 0.7 : 0
        const voice = f >= FRAMES / 2 ? Math.sin((f * FRAME + k) * 0.4) * 0.15 : 0
        near[k] = echo + voice
      }
      const out = ec.process(toPcm(near))
      const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
      for (let k = 0; k < FRAME; k += 1) {
        const v = dv.getInt16(k * 2, true) / 32768
        outAll.push(v)
        if (f < FRAMES / 2 - 5) { // 前半段稳定后纯回声
          sumBefore += near[k] ** 2
          sumAfter += v ** 2
          cnt += 1
        }
      }
    }
    const before = Math.sqrt(sumBefore / cnt)
    const after = Math.sqrt(sumAfter / cnt)
    // 回声应被明显抑制（至少降到 1/2）
    expect(after).toBeLessThan(before * 0.5)
    // 后半段：真人声应被保留（outAll 是浮点输出，直接算子段 rms，不应被消成静音）
    let voiceOut = 0, vcnt = 0
    for (let f = Math.floor(FRAMES * 0.7); f < FRAMES; f += 1) {
      for (let k = 0; k < FRAME; k += 1) { const v = outAll[f * FRAME + k]; voiceOut += v * v; vcnt += 1 }
    }
    const voiceRms = Math.sqrt(voiceOut / vcnt)
    // 人声幅度 0.15（rms≈0.106）；保留应 > 0.03，证明没把真人声当回声一起消掉
    expect(voiceRms).toBeGreaterThan(0.03)
  })

  it('未推参考时近似原样返回（仅量化误差）', () => {
    const ec = new EchoCanceller()
    const input = toPcm(new Float32Array([0.1, -0.2, 0.3, 0]))
    const out = ec.process(input)
    const dvI = new DataView(input.buffer), dvO = new DataView(out.buffer)
    for (let i = 0; i < 4; i += 1) {
      expect(Math.abs(dvO.getInt16(i * 2, true) - dvI.getInt16(i * 2, true))).toBeLessThanOrEqual(1)
    }
  })
})
