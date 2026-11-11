/** 语言可配置，默认中文 */
export const DEFAULT_LANGUAGE = 'zh-CN'

/** 时区可配置，默认东 8 区（中国标准时间） */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 常用时区选项；值用 IANA 名，展示文案走 i18n（label 由页面按当前语言翻译）。
 * 默认且置顶东 8 区，其余按 UTC 偏移升序排列。
 */
export const TIMEZONE_OPTIONS: Array<{ value: string; i18nKey: string }> = [
  { value: 'Asia/Shanghai', i18nKey: 'settings.timezone.shanghai' },
  { value: 'Asia/Tokyo', i18nKey: 'settings.timezone.tokyo' },
  { value: 'Asia/Singapore', i18nKey: 'settings.timezone.singapore' },
  { value: 'Europe/London', i18nKey: 'settings.timezone.london' },
  { value: 'America/New_York', i18nKey: 'settings.timezone.newyork' },
  { value: 'America/Los_Angeles', i18nKey: 'settings.timezone.losangeles' },
  { value: 'UTC', i18nKey: 'settings.timezone.utc' },
]

/** 当前字幕（悬浮小圆当前句 / 字幕面板高亮行）字号档位 px；设置页按档位选，脏值收敛 */
export const SUBTITLE_FONT_SIZE_OPTIONS = [14, 18, 22, 26] as const
export const DEFAULT_SUBTITLE_FONT_SIZE = 18
/** 当前字幕颜色预设：只允许这几个 hex，避免自由输入写出非法样式；默认白色 */
export const SUBTITLE_COLOR_OPTIONS = ['#ffffff', '#6c8cff', '#5cd6b2', '#ffb38a', '#ff8ab5'] as const
export const DEFAULT_SUBTITLE_COLOR = '#ffffff'

/** 把任意输入收敛到列表里的合法时区，非法或缺省回退东 8 区 */
export function normalizeTimezone(value: unknown): string {
  const raw = String(value ?? '').trim()
  if ((TIMEZONE_OPTIONS as Array<{ value: string }>).some((o) => o.value === raw)) {
    return raw
  }
  return DEFAULT_TIMEZONE
}

/** 网关默认主机与端口：仅当构建期未注入 VITE_GATEWAY_WS_URL 时回退。
 * 真正的地址来源统一为 VITE_GATEWAY_WS_URL（由 dev 脚本按后端 PORT 注入 / .env 配置）；
 * 这里的默认值刻意与后端 config.ts 的 PORT 默认（8787）对齐，仅作兜底、不要当业务常量依赖。 */
export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 8787
export const DEFAULT_GATEWAY_WS_URL = `ws://${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}/ws`

/**
 * DashScope 默认地址：仅用于客户端展示（DashScope 地址由网关固定、用户不填写）。
 * 与网关 config.ts 的 VOICE_DASHSCOPE_URL 默认保持一致；真实生效地址以网关返回为准。
 */
export const DEFAULT_DASHSCOPE_URL = 'https://dashscope.aliyuncs.com'

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** 语言名用各自母语展示，不随界面语言翻译 */
export const LANGUAGE_OPTIONS: Array<{ label: string; value: AppLanguage }> = [
  { label: '中文（简体）', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
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
