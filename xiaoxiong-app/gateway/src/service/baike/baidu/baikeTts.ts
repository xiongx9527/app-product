/**
 * 百度百科「播报」使用的语音合成接口封装。
 *
 * 用户明确要求：百科词条要用百度百科页面自己的语音播报，而不是网关把摘要文字
 * 用自己的 TTS 合成。百度百科 H5 词条页的「播报」按钮实际调用
 *   GET https://baike.baidu.com/lemma/api/getaudio?...
 * 返回一个 tts.baidu.com/text2audio 的 mp3 直链（CORS *、带 auth、约一百多分钟有效）。
 * 网关拿到即用即下发给客户端（media.play），不做长期缓存。
 *
 * sign 算法来自对百度百科 JS（resource/lemma/lemma_*.js）的逆向，已用多组真机请求交叉验证：
 *   sign = md5(text + "9" + per + time + once + SALT)
 * 其中 per 是音色 soundId（百科 H5 用 4100），time 为秒级时间戳字符串，once 为 uuid。
 * SALT 是百度前端写死的密钥。该接口是百度非公开接口，可能随时变更；调用失败时上层
 * 静默不播（不用网关文字转语音兜底），不要伪装成播放成功。
 */
import { createHash, randomUUID } from 'node:crypto'

/** getaudio 请求根地址（来源由网关持有，前端不接触）。 */
const GET_AUDIO_URL = 'https://baike.baidu.com/lemma/api/getaudio'
/** 百度百科 H5 前端写死的签名盐。 */
const SIGN_SALT = '%Ej9&lz9*1R5O*XCSXvY6E8PlWoZ@haY'
/** 百科播报音色 soundId（H5 默认 4100）。 */
const DEFAULT_SOUND_ID = '4100'
/** 卷：H5 固定 9。 */
const VOLUME = '9'
/** 单次请求超时，避免上游挂起拖死语音轮次。 */
const FETCH_TIMEOUT_MS = 8000

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 计算 getaudio 的 sign。导出供单测用已知样本校验，避免算法被无意改坏。
 * raw = text + vol + per + time + once + SALT，全部字符串直接拼接。
 */
export function baikeAudioSign(
  text: string,
  per: string,
  time: string,
  once: string
): string {
  return md5Hex(`${text}${VOLUME}${per}${time}${once}${SIGN_SALT}`)
}

/**
 * 调 getaudio 拿百科音频直链。
 * @param text 要播报的文本（标题 + 摘要，已清洗）
 * @param fetcher 可注入，便于测试；默认全局 fetch
 */
export async function fetchBaikeAudioUrl(
  text: string,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const trimmed = (text || '').trim()
  if (!trimmed) throw new Error('baike audio: empty text')
  const time = String(Math.floor(Date.now() / 1000))
  const once = randomUUID()
  const sign = baikeAudioSign(trimmed, DEFAULT_SOUND_ID, time, once)
  const params = new URLSearchParams({
    text: trimmed,
    vol: VOLUME,
    per: DEFAULT_SOUND_ID,
    time,
    once,
    sign,
  })
  const resp = await fetcher(`${GET_AUDIO_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`baike audio: getaudio HTTP ${resp.status}`)
  const body = (await resp.json()) as { errno?: number; data?: string }
  if (body.errno !== 0 || typeof body.data !== 'string' || !body.data) {
    throw new Error(`baike audio: getaudio errno=${body.errno}`)
  }
  return body.data
}

/** 中文 TTS 估算语速（字/秒），用于把摘要切成字幕行并分配起始时间。 */
const CHARS_PER_SEC = 4.5
/** 字幕行最短字数：短句并入前一句，避免切得太碎、边读边转时闪得太快。 */
const MIN_LINE_CHARS = 8

/**
 * 把百科摘要切成字幕行，供播放器「边读边转」逐句高亮：
 * 按中文句末标点切句，每行 time 为累计起始秒。
 * - 传了 durationSec（网关已拿到 mp3 真实时长）：按各行字数占比把 time 铺满整段音频，
 *   字幕走完时刻正好贴合音频结束（实测百度 TTS 语速约 6.5 字/秒，远快于早先 4.5 估算）。
 * - 没传：按 CHARS_PER_SEC 估算（兼容无音频场景/测试）。
 */
export function splitSummaryToLines(summary: string, durationSec?: number): Array<{ time: number; text: string }> {
  const clean = (summary || '').trim()
  if (!clean) return []
  // 在句末标点后切开，标点保留在该句
  const raw = clean.match(/[^。！？；!?;]+[。！？；!?;]?/g) ?? [clean]
  // 太短的句子并入前一句
  const sentences: string[] = []
  for (const s of raw) {
    const piece = s.trim()
    if (!piece) continue
    if (sentences.length && piece.replace(/[。！？；!?;]/g, '').length < MIN_LINE_CHARS) {
      sentences[sentences.length - 1] += piece
    } else {
      sentences.push(piece)
    }
  }
  const weights = sentences.map((s) => s.replace(/[。！？；!?;，,、\s]/g, '').length)
  const total = weights.reduce((a, b) => a + b, 0)
  const lines: Array<{ time: number; text: string }> = []
  let time = 0
  for (let i = 0; i < sentences.length; i += 1) {
    lines.push({ time: Math.round(time * 10) / 10, text: sentences[i] })
    time += durationSec && total > 0
      ? durationSec * weights[i] / total
      : weights[i] / CHARS_PER_SEC
  }
  return lines
}
