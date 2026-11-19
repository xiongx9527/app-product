/**
 * ASR 近音错字的确定性纠错（非 LLM、零网络、零误纠）。
 *
 * 词表完全来自数据：本地 learn_correction 学的 + 从 9529 同步的，经 SQLite 两表联查加载
 * （见 mapper.listFlat）。每条 = {wrong 错词字, pinyin 错词拼音, correct 正确词}。
 * 一个正确词可有多个错词。
 *
 * 不设内置默认词表：所有纠错词都必须是可管理、可同步的数据，不硬编码在代码里。
 *
 * 匹配：输入片段转无声调拼音 → 找 pinyin 相同的所有词表项 →
 *      这些项的 correct 全一致才纠成该 correct；不一致（如 shi li 对应实力/事例）就不纠。
 * 错词字 wrong 本身不参与文本匹配（只作信息），因为识别错字文本不可靠，拼音才稳定。
 */
import { pinyin } from 'pinyin-pro'

export interface CorrectionEntry {
  wrong: string // 错词字（信息用）
  pinyin: string // 错词拼音
  correct: string // 正确词
}

export function toPinyin(word: string): string {
  return pinyin(word, { toneType: 'none', type: 'array' }).join(' ')
}
const py = toPinyin

export class AsrCorrector {
  private byPinyin = new Map<string, Set<string>>() // 拼音 → 可能的 correct 集合

  constructor(extra: readonly CorrectionEntry[] = []) {
    this.load(extra)
  }

  /** 从 SQLite/同步词表整体重建（启动时 / 管理接口改词后即时刷新）。 */
  load(corrections: readonly CorrectionEntry[]): void {
    this.byPinyin = new Map()
    for (const c of corrections) {
      if (!c.pinyin || !c.correct) continue
      let set = this.byPinyin.get(c.pinyin)
      if (!set) { set = new Set(); this.byPinyin.set(c.pinyin, set) }
      set.add(c.correct)
    }
  }

  /** 拼音命中且 correct 唯一才纠正；多个不同 correct 不纠（防误伤）。 */
  private resolve(seg: string): string | null {
    const candidates = this.byPinyin.get(py(seg))
    if (!candidates || candidates.size !== 1) return null
    const correct = [...candidates][0]
    return correct === seg ? null : correct // 本来就是正确词，不改
  }

  correct(text: string): string {
    if (!text) return text
    const chars = [...text]
    const used = new Array(chars.length).fill(false)
    let result = ''
    for (let i = 0; i < chars.length; i += 1) {
      if (used[i]) continue
      let replaced = false
      for (let len = Math.min(5, chars.length - i); len >= 2; len -= 1) {
        if (used.slice(i, i + len).some(Boolean)) continue
        const seg = chars.slice(i, i + len).join('')
        if (!/^[\u4e00-\u9fff]+$/.test(seg)) continue
        const hit = this.resolve(seg)
        if (hit) {
          result += hit
          for (let k = i; k < i + len; k += 1) used[k] = true
          replaced = true
          break
        }
      }
      if (!replaced) result += chars[i]
    }
    return result
  }
}
