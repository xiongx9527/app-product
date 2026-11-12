import { onBackPress } from '@dcloudio/uni-app'

/**
 * 子页面统一返回逻辑：
 * - 有上一级（正常 navigateTo 进入）走 uni.navigateBack；
 * - 无上一级（直链/刷新进入，页面栈只有自身）reLaunch 到 fallbackUrl，避免卡死；
 * - 安卓物理返回键等场景通过 onBackPress 同样兜底。
 *
 * @param opts.intercept   可选拦截：返回 true 表示已自行处理（如编辑态取消），外层不要再返回。
 * @param opts.fallbackUrl 无上一级时的兜底目标，默认回设置页；设置页自身应传首页。
 */
export function useSubPageBack(opts?: { intercept?: () => boolean; fallbackUrl?: string }): { goBack: () => void } {
  const fallback = opts?.fallbackUrl ?? '/pages/settings/settings'

  function goBack(): void {
    if (opts?.intercept && opts.intercept()) return
    if (getCurrentPages().length > 1) uni.navigateBack()
    else uni.reLaunch({ url: fallback })
  }

  onBackPress(() => {
    if (opts?.intercept && opts.intercept()) return true
    if (getCurrentPages().length > 1) return false
    uni.reLaunch({ url: fallback })
    return true
  })

  return { goBack }
}
