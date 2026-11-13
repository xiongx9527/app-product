/**
 * 主题：用一组 CSS 变量（挂在 :root 上）驱动整体配色，切换主题即改写变量，页面无需改结构。
 * 全为深色方案，差异在强调色与背景辉光；"auto" 跟随系统（当前仅深色设计，回退 default）。
 */
export type ThemeId = 'auto' | 'default' | 'purple' | 'teal' | 'amber'

interface ThemeVars {
  accent: string
  accent2: string
  /** 用于半透明边框/辉光：rgb 三元组，配合 rgba(var(--accent-rgb), a) 使用 */
  accentRgb: string
  bgBase: string
  /** 顶部辉光（已含透明度） */
  bgGlow: string
}

export const THEME_VARS: Record<Exclude<ThemeId, 'auto'>, ThemeVars> = {
  default: {
    accent: '#6c8cff',
    accent2: '#8a6cff',
    accentRgb: '108, 140, 255',
    bgBase: '#0f1220',
    bgGlow: 'rgba(108, 140, 255, 0.18)',
  },
  purple: {
    accent: '#a06bff',
    accent2: '#ff6bd0',
    accentRgb: '160, 107, 255',
    bgBase: '#140f20',
    bgGlow: 'rgba(160, 107, 255, 0.20)',
  },
  teal: {
    accent: '#39d3c0',
    accent2: '#5b8cff',
    accentRgb: '57, 211, 192',
    bgBase: '#0b1418',
    bgGlow: 'rgba(57, 211, 192, 0.16)',
  },
  amber: {
    accent: '#ffb24c',
    accent2: '#ff6b6b',
    accentRgb: '255, 178, 76',
    bgBase: '#1a130c',
    bgGlow: 'rgba(255, 178, 76, 0.16)',
  },
}

export const THEME_IDS: ThemeId[] = ['auto', 'default', 'purple', 'teal', 'amber']

function resolveAuto(): Exclude<ThemeId, 'auto'> {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      // 当前仅深色设计：浅色系统也回退到 default，避免无浅色主题时发白。
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'default'
    }
  } catch {
    // 忽略，回退 default
  }
  return 'default'
}

function resolveVars(id: ThemeId): ThemeVars {
  return THEME_VARS[id === 'auto' ? resolveAuto() : id]
}

/**
 * 取某主题的 CSS 变量对象（key 为 --xxx）。用于在各页面根元素上以 `:style` 响应式绑定，
 * 经 uni-app 桥接到视图层 DOM（App 平台「逻辑层」无 document，直接操作 document 是空操作，
 * 只有 Vue 的 :style 绑定能真正落到可见页面上）。CSS 变量会向下层叠，整页配色随之变化。
 */
export function themeVarStyle(id: ThemeId): Record<string, string> {
  const v = resolveVars(id)
  return {
    '--accent': v.accent,
    '--accent-2': v.accent2,
    '--accent-rgb': v.accentRgb,
    '--bg-base': v.bgBase,
    '--bg-glow': v.bgGlow,
  }
}

/** 主题对应的 data-theme 取值（auto 解析为实际主题，供需要时按属性区分样式）。 */
export function dataThemeValue(id: ThemeId): string {
  return id === 'auto' ? resolveAuto() : id
}
