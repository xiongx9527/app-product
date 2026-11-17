/**
 * 音量控制指令识别：把用户口语映射到动作，绕开大模型，保证「说音量就真调」。
 * 只识别高置信度的音量词，避免与普通对话冲突（如「声音真好听」不会误触发）。
 *
 * 三类动作：
 *  - set：明确给了目标值（音量 30% / 调整音量为 30% / 音量调到最大 / 一半）→ 设到绝对值；
 *  - increase：调大 / 增大 / 提高 …（无具体值时默认 +10%）；
 *  - decrease：调小 / 减小 / 降低 …（无具体值时默认 -10%）。
 * 「再减 / 再增 / 再调小 / 再调大」里的「再」是「再来一次」之意，仍落到增减动作，
 * 不需要特殊分支——增减本就是相对当前音量的，天然支持「调小后再减」。
 */

export type VolumeAction =
  | { kind: 'set'; value: number }
  | { kind: 'increase' }
  | { kind: 'decrease' }
  | null

/** 含音量词（音量/声音/声量）或明确的增减动词才像音量指令，避免误伤普通对话。 */
const VOLUME_NOUN = /(音量|声音|声量)/
const INCREASE_RE =
  /(调大|增大|加大|提高|调高|升高|大一点|大一些|大点|大声|再(调大|增大|加大|提高|调高|升高|大|增)|增)/
const DECREASE_RE =
  /(调小|减小|降低|调低|小一点|小一些|小点|小声|再(调小|减小|降低|调低|小|减)|减)/

function looksLikeVolume(text: string): boolean {
  return VOLUME_NOUN.test(text) || INCREASE_RE.test(text) || DECREASE_RE.test(text)
}

/** 简体中文数字（零~百）→ 数值；只覆盖音量百分比常见范围，够用即可。 */
const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
function parseCnNumber(s: string): number | null {
  if (!s) return null
  if (s === '十') return 10
  let total = 0
  let section = 0
  for (const ch of s) {
    if (ch === '十') {
      section = section === 0 ? 10 : section * 10
    } else if (ch === '百') {
      section = section === 0 ? 100 : section * 100
    } else if (CN_DIGIT[ch] !== undefined) {
      section = CN_DIGIT[ch]
    } else {
      return null
    }
    // 个位或整十/整百段结算：遇到「十/百」后若还有更高位则继续累加
    if (ch === '十' || ch === '百') {
      total += section
      section = 0
    }
  }
  return total + section
}

/** 把口语里的音量目标解析成 0–1；没有目标值返回 null（交由增减动作给默认步长）。 */
export function parseVolumePercent(text: string): number | null {
  if (/最大(声|音量)?/.test(text)) return 1
  if (/最小(声|音量)?/.test(text)) return 0
  if (/(一半|适中|中等|半声)/.test(text)) return 0.5
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pct) return clamp01(Number(pct[1]) / 100)
  const bai = text.match(/百分之\s*([\d零〇一两二三四五六七八九十百]+)/)
  if (bai) {
    const n = bai[1].match(/^\d+(?:\.\d+)?$/) ? Number(bai[1]) : parseCnNumber(bai[1])
    if (n !== null && Number.isFinite(n)) return clamp01(n / 100)
  }
  const num = text.match(/(\d+(?:\.\d+)?)/)
  if (num) return clamp01(Number(num[1]) / 100)
  return null
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(1, Math.max(0, v))
}

/** 返回匹配到的音量动作；非音量指令返回 null。 */
export function detectVolumeCommand(text: string): VolumeAction {
  const t = (text || '').trim()
  if (!t || !looksLikeVolume(t)) return null

  // 1) 有明确目标值（数字 / 最大 / 最小 / 一半）→ 设到绝对值；即便带了「调大」也按绝对值理解
  //    （「调大音量到 50%」语义仍是「设到 50%」，而非在 50% 基础上再加）。
  const target = parseVolumePercent(t)
  if (target !== null) return { kind: 'set', value: target }

  // 2) 调大 / 增大 / 提高 / 加大 / 调高 / 升高 / 大一点…（含「再增 / 再调大」）
  if (INCREASE_RE.test(t)) return { kind: 'increase' }
  // 3) 调小 / 减小 / 降低 / 调低 / 小一点…（含「再减 / 再调小」）
  if (DECREASE_RE.test(t)) return { kind: 'decrease' }
  return null
}
