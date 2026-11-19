import { describe, it, expect } from 'vitest'
import { mp3DurationSec } from '../../../src/service/media/mp3Duration'

/** 造一帧：给定 4 字节帧头，按指定长度补零。 */
function frame(header: number[], length: number): Buffer {
  const b = Buffer.alloc(length)
  Buffer.from(header).forEach((v, i) => { b[i] = v })
  return b
}

describe('mp3DurationSec（本地 MP3 时长解析）', () => {
  it('MPEG1 Layer III 128kbps/44.1kHz：按帧数累加真实时长', () => {
    // 0xFF 0xFB 0x90 0x00：MPEG1 / Layer III / 128kbps / 44100Hz / 无 padding
    // 帧长 = floor(1152/8*128000/44100) = 417 字节，每帧 1152/44100 秒
    const n = 100
    const buf = Buffer.concat(Array.from({ length: n }, () => frame([0xff, 0xfb, 0x90, 0x00], 417)))
    expect(mp3DurationSec(buf)).toBeCloseTo((n * 1152) / 44100, 2)
  })

  it('跳过开头的 ID3v2 标签', () => {
    const id3 = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([0x04, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x10]), // syncsafe size = 16
      Buffer.alloc(16),
    ])
    const n = 10
    const audio = Buffer.concat(Array.from({ length: n }, () => frame([0xff, 0xfb, 0x90, 0x00], 417)))
    expect(mp3DurationSec(Buffer.concat([id3, audio]))).toBeCloseTo((n * 1152) / 44100, 2)
  })

  it('VBR：不同码率的帧都能计入（不假设固定码率）', () => {
    // 0xFF 0xFB 0x50 0x00：64kbps → 帧长 208；0xFF 0xFB 0xB0 0x00：192kbps → 帧长 626
    const a = frame([0xff, 0xfb, 0x50, 0x00], 208)
    const b = frame([0xff, 0xfb, 0xb0, 0x00], 626)
    const buf = Buffer.concat([a, a, b, b])
    expect(mp3DurationSec(buf)).toBeCloseTo((4 * 1152) / 44100, 2)
  })

  it('不是 mp3 / 帧数不足返回 0（调用方回退估算）', () => {
    expect(mp3DurationSec(Buffer.from('not an mp3 file at all'))).toBe(0)
    expect(mp3DurationSec(Buffer.alloc(0))).toBe(0)
  })
})
