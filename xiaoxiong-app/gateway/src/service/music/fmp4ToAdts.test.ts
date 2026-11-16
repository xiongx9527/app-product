import { describe, it, expect } from 'vitest'
import { createFmp4ToAdtsStream } from './fmp4ToAdts'

/** 构造最小 fMP4（ftyp+moov(esds)+moof(trun)+mdat），结构与 B站 dash 音轨一致。 */
function buildSampleFmp4(): Buffer {
  // AudioSpecificConfig：AOT=2(LC) sfidx=4(44100Hz) ch=2 → 0x12 0x10
  const asc = Buffer.from([0x12, 0x10])
  const esdsBody = Buffer.concat([
    Buffer.from([0x03, 0x80, 0x80, 0x80, 0x22, 0x00, 0x01, 0x00]),
    Buffer.from([0x04, 0x80, 0x80, 0x80, 0x14, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0xfa, 0x05, 0x00, 0x00, 0xfa, 0x05]),
    Buffer.from([0x05, 0x80, 0x80, 0x80, 0x02]),
    asc,
    Buffer.from([0x06, 0x80, 0x80, 0x80, 0x01, 0x02]),
  ])
  const esds = Buffer.concat([Buffer.from([0, 0, 0, 8 + esdsBody.length]), Buffer.from('esds'), esdsBody])
  const mp4a = Buffer.concat([Buffer.alloc(28), esds]) // 简化 mp4a body
  const stsd = Buffer.concat([Buffer.alloc(16), Buffer.from([0, 0, 0, 8 + mp4a.length]), Buffer.from('mp4a'), mp4a])
  const moovBody = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from([0, 0, 0, 8 + stsd.length]), Buffer.from('stsd'), stsd,
  ])
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + moovBody.length]), Buffer.from('moov'), moovBody])
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from('iso5iso6mp41dash')])

  // trun：flags=0x201（data-offset + per-sample size），2 个样本 100/120 字节
  const trunBody = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x02, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x02]),
    Buffer.from([0x00, 0x00, 0x00, 0x10]), // data_offset = 16（相对 moof：mdat body 起点）
    Buffer.from([0x00, 0x00, 0x00, 100]), // sample 1 size
    Buffer.from([0x00, 0x00, 0x00, 120]), // sample 2 size
  ])
  const trun = Buffer.concat([Buffer.from([0, 0, 0, 8 + trunBody.length]), Buffer.from('trun'), trunBody])
  const traf = Buffer.concat([Buffer.from([0, 0, 0, 8 + trun.length]), Buffer.from('traf'), trun])
  const moof = Buffer.concat([Buffer.from([0, 0, 0, 8 + traf.length]), Buffer.from('moof'), traf])
  const sampleData = Buffer.alloc(220, 0xab)
  const mdat = Buffer.concat([Buffer.from([0, 0, 0, 8 + sampleData.length]), Buffer.from('mdat'), sampleData])
  return Buffer.concat([ftyp, moov, moof, mdat])
}

describe('createFmp4ToAdtsStream（dash fMP4 → ADTS 裸 AAC）', () => {
  it('moov 的 esds 提供参数，moof/trun 样本加 7 字节 ADTS 头输出', async () => {
    const t = createFmp4ToAdtsStream()
    const chunks: Buffer[] = []
    const done = new Promise<void>((resolve) => {
      t.on('data', (c: Buffer) => chunks.push(c))
      t.on('end', resolve)
    })
    // 分两块喂入（模拟流式），box 跨块
    const data = buildSampleFmp4()
    t.write(data.subarray(0, 40))
    t.write(data.subarray(40))
    t.end()
    await done
    const out = Buffer.concat(chunks)
    // 2 个样本：各 7 字节头 + 100/120 字节
    expect(out.length).toBe(7 + 100 + 7 + 120)
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xf1)
    // sfidx=4 → b2 bit3-2 = 01（(4<<2)&0x3f）
    expect(out[2] & 0x3c).toBe(4 << 2)
    // 第二帧头
    expect(out[107]).toBe(0xff)
    expect(out[108]).toBe(0xf1)
  })
})
