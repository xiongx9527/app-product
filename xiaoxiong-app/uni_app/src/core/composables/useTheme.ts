import { computed, type ComputedRef } from 'vue'
import { appConfig } from '@/core/config'
import { themeVarStyle, dataThemeValue } from '@/core/theme'

/**
 * 当前主题的 CSS 变量（响应式）。绑定到每个页面根元素的 :style，经 uni-app 桥接到视图层 DOM，
 * 因此只要 appConfig.general.theme 变化（设置页修改并落盘），所有已打开页面会自动同步换色，
 * 无需手动广播或 onShow 重刷——这是 App 平台下唯一能落到可见页面的方式（逻辑层无 document）。
 */
export function useThemeStyle(): {
  themeStyle: ComputedRef<Record<string, string>>
  dataTheme: ComputedRef<string>
} {
  const themeStyle = computed(() => themeVarStyle(appConfig.general.theme))
  const dataTheme = computed(() => dataThemeValue(appConfig.general.theme))
  return { themeStyle, dataTheme }
}

/** 兼容旧引用：历史代码里 `useApplyTheme()` 已不再需要（主题改由 :style 响应式绑定驱动）。 */
export function useApplyTheme(): void {
  /* no-op：保留签名以免遗漏调用处编译报错；主题已由 useThemeStyle 的 :style 绑定接管 */
}
