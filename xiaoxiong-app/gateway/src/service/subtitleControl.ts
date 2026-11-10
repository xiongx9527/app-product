/**
 * 字幕开关指令识别：把用户口语映射到开关动作，绕开大模型，保证「说关闭就真关」。
 * 只识别高置信度的字幕/歌词开关词，避免与普通对话冲突（如「字幕很好看」不会误触发）。
 *
 * 两类动作：
 *  - off：关闭字幕（关闭 / 关掉 / 关了 / 隐藏 / 去掉 / 不要 / 别 / 停 + 字幕/歌词）；
 *  - on：开启字幕（开启 / 打开 / 显示 / 展示 / 看 / 要 + 字幕/歌词）。
 * 只含名词（如「字幕是什么」问句）不命中，交给大模型正常应答。
 */

export type SubtitleAction = 'on' | 'off' | null

const SUBTITLE_NOUN = /(字幕|歌词)/
const OFF_RE = /(关闭|关掉|关了|隐藏|去掉|移除|收起|不要|别|停|关)/
// 「看」只在紧贴名词（看字幕/看歌词）时算开启，避免「字幕很好看」这类误触发
const ON_RE = /(开启|打开|显示|展示|要|看字幕|看歌词)/

/** 返回匹配到的字幕开关动作；非字幕指令返回 null。 */
export function detectSubtitleCommand(text: string): SubtitleAction {
  const t = (text || '').replace(/\s/g, '')
  if (!t || !SUBTITLE_NOUN.test(t)) return null
  // 关类词命中 → 关闭；开类词命中 → 开启。两者都不命中（纯「字幕」问句）交由大模型。
  if (OFF_RE.test(t)) return 'off'
  if (ON_RE.test(t)) return 'on'
  return null
}
