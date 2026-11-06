export type Breakpoint = 'compact' | 'medium' | 'expanded'

/** 与设计文档一致的断点：手机 / 平板竖屏 / 平板横屏与桌面 */
export function getBreakpoint(width: number): Breakpoint {
  if (width < 600) return 'compact'
  if (width <= 1024) return 'medium'
  return 'expanded'
}

export interface ScreenInfo {
  width: number
  height: number
  breakpoint: Breakpoint
  safeTop: number
  safeBottom: number
  platform: string
  model: string
}

export function readScreenInfo(): ScreenInfo {
  const info = uni.getSystemInfoSync()
  const safeArea = info.safeArea
  return {
    width: info.windowWidth,
    height: info.windowHeight,
    breakpoint: getBreakpoint(info.windowWidth),
    safeTop: safeArea ? safeArea.top : 0,
    safeBottom: safeArea ? info.screenHeight - safeArea.bottom : 0,
    platform: info.platform,
    model: info.model ?? '',
  }
}
