import type { SubtitleLine } from '../../../protocol'

/** 解析 LRC 文本为带时间的字幕行；支持一行多时间标签 [mm:ss.xx][mm:ss.xx]文本。 */
export function parseLrc(raw: string): SubtitleLine[] {
  const out: SubtitleLine[] = []
  const tagRe = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of raw.split('\n')) {
    const tags = line.match(tagRe)
    if (!tags || !tags.length) continue
    const text = line.replace(tagRe, '').trim()
    if (!text) continue
    for (const tag of tags) {
      const m = tagRe.exec(tag)
      tagRe.lastIndex = 0
      if (!m) continue
      const mins = Number(m[1])
      const secs = Number(m[2])
      const frac = m[3] ? Number(`0.${m[3]}`) : 0
      const time = mins * 60 + secs + frac
      if (Number.isFinite(time)) out.push({ time, text })
    }
  }
  return out
}
