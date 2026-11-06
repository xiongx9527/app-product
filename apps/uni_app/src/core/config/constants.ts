/** 语言可配置，默认中文 */
export const DEFAULT_LANGUAGE = 'zh-CN'

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'] as const
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** 语言名用各自母语展示，不随界面语言翻译 */
export const LANGUAGE_OPTIONS: Array<{ label: string; value: AppLanguage }> = [
  { label: '中文（简体）', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
  { label: '日本語', value: 'ja-JP' },
]

/** 把系统语言、旧配置等任意输入收敛到支持的语言 */
export function normalizeLanguage(value: unknown): AppLanguage {
  const raw = String(value ?? '').trim()
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as AppLanguage
  }
  const lower = raw.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  if (lower.startsWith('ja')) return 'ja-JP'
  return DEFAULT_LANGUAGE
}

/** 首次启动跟随系统语言；取不到就中文 */
export function detectLanguage(): AppLanguage {
  try {
    const scope = globalThis as unknown as {
      uni?: {
        getSystemInfoSync?: () => { language?: string; locale?: string }
      }
    }
    const info = scope.uni?.getSystemInfoSync?.()
    const candidate = info?.language ?? info?.locale
    if (candidate) return normalizeLanguage(candidate)
  } catch {
    // 系统信息不可用时用默认语言
  }
  return DEFAULT_LANGUAGE
}

export function languageLabel(value: string): string {
  return (
    LANGUAGE_OPTIONS.find((item) => item.value === value)?.label ??
    normalizeLanguage(value)
  )
}
