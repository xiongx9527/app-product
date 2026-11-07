import { formatTime } from '../text/time'

/**
 * 播放器进度条的纯计算：状态 → 百分比 / 时间标签。
 *
 * 电台是无限流（duration 为 Infinity 或 0），没有总时长也不能拖，
 * 界面要退化成「已听时长 + 直播」；歌曲才有进度和总时长。
 * 抽成纯函数便于单测，页面只负责把 ref 传进来。
 */

export interface MusicProgress {
  currentTime: number
  duration: number
  /** 直播流标记：由播放器在拿不到总时长时置位 */
  live: boolean
}

export function isSeekable(state: MusicProgress): boolean {
  return !state.live && Number.isFinite(state.duration) && state.duration > 0
}

/** 已播放秒数；拖动预览优先于真实播放位置 */
export function elapsedSeconds(state: MusicProgress, preview: number | null = null): number {
  const time = preview ?? state.currentTime
  return Number.isFinite(time) && time > 0 ? time : 0
}

/** 进度百分比，夹在 0~100；直播/未知时长固定 0 */
export function progressPercent(state: MusicProgress, preview: number | null = null): number {
  if (!isSeekable(state)) return 0
  const percent = (elapsedSeconds(state, preview) / state.duration) * 100
  return Math.min(100, Math.max(0, percent))
}

/** 左侧时间标签：直播也显示已听时长 */
export function elapsedLabel(state: MusicProgress, preview: number | null = null): string {
  return formatTime(elapsedSeconds(state, preview))
}

/** 右侧总时长标签：直播没有总时长，返回空串让界面只显示「直播」 */
export function totalLabel(state: MusicProgress): string {
  return isSeekable(state) ? formatTime(state.duration) : ''
}

/** 滑块百分比 → 秒；越界或非法值收敛到合法区间 */
export function seekSeconds(percent: number, duration: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(duration) || duration <= 0) return 0
  const clamped = Math.min(100, Math.max(0, percent))
  return (clamped / 100) * duration
}
