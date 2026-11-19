/**
 * 通用媒体意图解析（系统能力，不依赖任何内容 skill）。
 * 循环遍数、「再」上下文标记——这些对所有媒体内容（音乐/新闻/诗词/百科）都一样，
 * 不该放在某个内容 skill 的 detect 里。
 */

/**
 * 从口语里解析显式「循环 N 遍」的遍数；返回 1 表示「未指定遍数，交回设置里的默认循环次数」。
 *  - 「循环播放3遍」→ 3；超上限收敛，避免极端值拖垮播放。
 *  - 「再放一遍 / 再来一次」是明确「多播一次」→ 固定 2。
 *  - 不带遍数的「循环播放 / 单曲循环 / 重复播放」→ 1，由上层落默认循环次数，
 *    绝不写死 2 把用户的 3 遍设置盖掉。
 */
export function parseLoopCount(text: string, max = 99): number {
  const t = (text || '').trim()
  if (!t) return 1
  const m = t.match(/(\d+)\s*遍/)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), max)
    return 1
  }
  if (/再(放|来|播).*(一遍|一次)/.test(t)) return 2
  return 1
}

/**
 * 是否含「再」——「再说一次 / 再放一首 / 再听」里的「再」表示「另来一次」，
 * 关掉跨轮上下文（不依赖上一轮的歌手/歌名/状态），当作全新请求（重新检索 / 列候选）。
 * 通用原则：凡带「再」的请求都不沿用上一轮上下文。
 */
export function hasAgainMarker(text: string): boolean {
  return /再/.test(text || '')
}
