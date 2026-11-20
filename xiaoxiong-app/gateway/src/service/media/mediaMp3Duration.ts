/**
 * 纯本地 MP3 时长解析（不依赖 ffprobe / 原生库，设备端 NodeMobile 也能跑）。
 *
 * 背景（2026-11-18 真机）：诗词字幕按 `bytes * 8 / 32000` 估算时长，假设百度 TTS
 * mp3 是 32kbps/16kHz 单声道。实际诗词音频并不统一：岳阳楼记是 320kbps/44.1kHz
 * 立体声（估算 2126s，真实 213s），滕王阁序是 ~57kbps/44.1kHz（估算 729s，真实
 * 411s）。估长后字幕按比例铺得越来越慢，表现就是「字幕慢于声音」。
 *
 * 做法：跳过 ID3v2 标签，逐帧解析 MPEG 音频帧头（version/layer/bitrate/sampleRate/
 * padding），按每帧样本数累加时长。CBR/VBR 都适用。
 */

/** MPEG1 各层的比特率表（kbps），下标 = 帧头 bitrate index。 */
const BITRATES_V1: Record<number, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
}

/** MPEG2 / MPEG2.5 各层的比特率表（kbps）。 */
const BITRATES_V2: Record<number, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

/** 采样率表，key = 帧头 version bits（3=MPEG1，2=MPEG2，0=MPEG2.5）。 */
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

/** 读同步安全整数（ID3v2 头里的 size 每字节只用低 7 位）。 */
function syncSafeInt(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  )
}

/**
 * 解析 MP3 总时长（秒）。解析不出有效帧返回 0，调用方回退其它估算。
 * 遍历完整帧数据（音频文件最长几分钟、只在播放前算一次，开销可接受）。
 */
export function mp3DurationSec(buf: Uint8Array): number {
  if (buf.length < 8) return 0
  let pos = 0
  // 跳过 ID3v2 标签（文件开头是 "ID3"）；带 footer 标志时多 10 字节。
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    if (buf.length < 10) return 0
    pos = 10 + syncSafeInt(buf, 6)
    if (buf[5] & 0x10) pos += 10
    if (pos >= buf.length) return 0
  }
  let seconds = 0
  let frames = 0
  while (pos + 4 <= buf.length) {
    // 帧同步：11 个 1（0xFF + 高 3 位）
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
      pos += 1
      continue
    }
    const b1 = buf[pos + 1]
    const b2 = buf[pos + 2]
    const version = (b1 >> 3) & 0x03
    const layerBits = (b1 >> 1) & 0x03
    const bitrateIndex = (b2 >> 4) & 0x0f
    const sampleRateIndex = (b2 >> 2) & 0x03
    const padding = (b2 >> 1) & 0x01
    // version=1/layer=0 保留值；bitrate 0（free）/15（bad）、采样率 3 都无效
    if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      pos += 1
      continue
    }
    const layer = 4 - layerBits
    const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[layer]?.[bitrateIndex]
    const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex]
    if (!bitrate || !sampleRate) {
      pos += 1
      continue
    }
    // Layer I 每帧 384 样本；Layer II 固定 1152；Layer III 在 MPEG1 是 1152、MPEG2/2.5 是 576
    const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version === 3 ? 1152 : 576
    const frameLength = Math.floor((samples / 8) * bitrate * 1000 / sampleRate) + padding
    if (frameLength < 4) {
      pos += 1
      continue
    }
    seconds += samples / sampleRate
    frames += 1
    pos += frameLength
  }
  // 至少 2 帧才算解析成功，避免把随机数据里的偶发同步字当成音频
  return frames >= 2 ? seconds : 0
}
