import { Transform } from 'node:stream'

/**
 * B站 dash 纯音轨（m4s）是 fragmented MP4（ftyp brand=iso5/dash，样本在 moof+mdat 片段里）：
 * 设备端 NuPlayer 的 MPEG4Extractor 对 dash brand 嗅探失败（GenericSource: cannot create
 * extractor → MEDIA_ERROR(100,-2147483648)，DCloud AudioPlayer 还不回调 onError），表现为
 * 「非歌曲宝的音频没声音」。本流式转封装把 fMP4 解成 ADTS 裸 AAC 流（每帧加 7 字节头），
 * NuPlayer 的 ADTS 通路原生可播；macOS 上已用同算法原型 ffprobe/试听验证（2026-11-16）。
 *
 * 结构（实测 B站音轨）：ftyp → moov(含 esds→AudioSpecificConfig) → sidx → (moof → mdat)*。
 * trun flags=0x201：data-offset-present + per-sample size-present（无 duration/flags/cto）。
 * 样本数据相对 moof 起点偏移 data_offset；mdat 紧随 moof，偏移落在 mdat body 内。
 * 仅在拿到 ASC（moov）后才开始输出；Range seek 不支持（起点非 box 边界会坏），
 * 转封装响应不带 content-length / Accept-Ranges，客户端按无限流播（对音乐播放足够）。
 */

export interface AdtsParams {
  /** MPEG-4 Audio Object Type（2 = AAC LC） */
  aot: number
  /** 采样率表索引（4 = 44100Hz） */
  sfidx: number
  /** 声道数 */
  ch: number
}

interface PendingMoof {
  /** moof box 总大小（用于把相对 moof 的 data_offset 换算到 mdat body 内） */
  moofSize: number
  dataOffset: number
  sizes: number[]
}

/** 从 moov box 里提取 AudioSpecificConfig（esds → 05 xx... ），得 ADTS 头参数。 */
function parseAscFromMoov(moov: Buffer): AdtsParams | null {
  const i = moov.indexOf('esds')
  if (i < 0) return null
  // DecoderSpecificInfo：tag 05（带 0x80 0x80 0x80 扩展长度）
  const k = moov.indexOf(Buffer.from([0x05, 0x80, 0x80, 0x80]), i)
  if (k < 0) return null
  const len = moov[k + 4]
  if (len < 2) return null
  const asc = moov.subarray(k + 5, k + 5 + len)
  const b0 = asc[0]
  const b1 = asc[1] ?? 0
  const aot = (b0 >> 3) & 0x1f
  const sfidx = ((b0 & 0x07) << 1) | (b1 >> 7)
  const ch = (b1 >> 3) & 0x0f
  if (sfidx === 15 || ch === 0) return null
  return { aot, sfidx, ch }
}

/** 从 moof box 提取 trun 的样本尺寸表与 data offset。 */
function parseTrunFromMoof(moof: Buffer): PendingMoof | null {
  const i = moof.indexOf('trun')
  if (i < 0) return null
  const body = moov_sub(moof, i)
  const sf = body.readUInt32BE(0)
  const n = body.readUInt32BE(4)
  let p = 8
  let dataOffset: number | null = null
  if (sf & 0x01) {
    dataOffset = body.readInt32BE(p)
    p += 4
  }
  if (sf & 0x04) p += 4
  const sizes: number[] = []
  for (let s = 0; s < n && p + 4 <= body.length; s += 1) {
    if (sf & 0x100) p += 4 // duration
    if (sf & 0x200) {
      sizes.push(body.readUInt32BE(p))
      p += 4
    }
    if (sf & 0x400) p += 4 // sample flags
    if (sf & 0x800) p += 4 // composition time offset
  }
  if (dataOffset === null || !sizes.length) return null
  // moof box 总大小：trun 所在 moof 的 size（box[0..4]），从外层记录传入更直接；
  // 这里向上找不到，故由调用方把 moofSize 一并传给本函数（见 createFmp4ToAdtsStream）。
  return { moofSize: 0, dataOffset, sizes }
}

/** 取 box 内以 type 出现位置开始的 box body（type 后 4 字节起）。 */
function moov_sub(box: Buffer, typePos: number): Buffer {
  // typePos 指向 'trun' 文本；box 头在其前 4 字节
  const header = typePos - 4
  const size = box.readUInt32BE(header)
  return box.subarray(header + 8, header + size)
}

function adtsHeader(sampleLen: number, p: AdtsParams): Buffer {
  const fl = sampleLen + 7
  const b2 = ((p.aot - 1) << 6) | (p.sfidx << 2) | ((p.ch >> 2) & 1)
  const b3 = ((p.ch & 3) << 6) | ((fl >> 11) & 3)
  return Buffer.from([
    0xff,
    0xf1,
    b2,
    b3,
    (fl >> 3) & 0xff,
    ((fl & 0x07) << 5) | 0x1f,
    0xfc,
  ])
}

/**
 * 把 fMP4（ftyp/moov/sidx/moof/mdat...）流转封装成 ADTS 裸 AAC 流。
 * ASC 未到（moov 未过）前缓冲上游数据；拿到 mdat 后逐帧输出。
 */
export function createFmp4ToAdtsStream(): Transform {
  let buf: Buffer = Buffer.alloc(0)
  let params: AdtsParams | null = null
  let pending: (PendingMoof & { moofSize: number }) | null = null
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      for (;;) {
        if (buf.length < 8) break
        const size = buf.readUInt32BE(0)
        if (size < 8 || size > 64 * 1024 * 1024) {
          cb(new Error('fmp4-to-adts: bad box size'))
          return
        }
        if (buf.length < size) break // box 未收齐，等下一块
        const type = buf.toString('latin1', 4, 8)
        const box = buf.subarray(0, size)
        buf = buf.subarray(size)
        if (type === 'moov') {
          params ??= parseAscFromMoov(box)
        } else if (type === 'moof') {
          pending = parseTrunFromMoof(box)
          if (pending) pending.moofSize = size
        } else if (type === 'mdat' && pending && params) {
          // 样本绝对偏移 = moofOff + dataOffset；mdatOff = moofOff + moofSize（mdat 紧随 moof）
          // → 相对 mdat box 的偏移 = dataOffset - moofSize（实测 B站：972 - 964 = 8 = mdat body 起点）
          let cur = pending.dataOffset - pending.moofSize
          if (cur < 8) cur = 8
          for (const sz of pending.sizes) {
            if (cur + sz > box.length) break
            this.push(adtsHeader(sz, params))
            this.push(box.subarray(cur, cur + sz))
            cur += sz
          }
          pending = null
        }
      }
      cb()
    },
    flush(cb) {
      cb()
    },
  })
}

/**
 * 全量转封装：把完整 fMP4 buffer 一次转成完整 ADTS buffer。
 * 用于「先转完再响应」的模式——响应是带 content-length 的完整文件，支持任意 Range/seek
 * （流式转封装只支持从头播，播放器 seek/续传发出的中途 Range 会坏流，导致时好时坏）。
 */
export function fmp4BufferToAdts(full: Buffer): Buffer {
  const out: Buffer[] = []
  let params: AdtsParams | null = null
  let pending: (PendingMoof & { moofSize: number }) | null = null
  let o = 0
  while (o + 8 <= full.length) {
    const size = full.readUInt32BE(o)
    if (size < 8 || o + size > full.length) break
    const type = full.toString('latin1', o + 4, o + 8)
    const box = full.subarray(o, o + size)
    o += size
    if (type === 'moov') {
      params ??= parseAscFromMoov(box)
    } else if (type === 'moof') {
      const t = parseTrunFromMoof(box)
      if (t) pending = { ...t, moofSize: size }
    } else if (type === 'mdat' && pending && params) {
      let cur = pending.dataOffset - pending.moofSize
      if (cur < 8) cur = 8
      for (const sz of pending.sizes) {
        if (cur + sz > box.length) break
        out.push(adtsHeader(sz, params))
        out.push(box.subarray(cur, cur + sz))
        cur += sz
      }
      pending = null
    }
  }
  return Buffer.concat(out)
}
