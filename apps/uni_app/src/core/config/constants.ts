import type { GeocodeConfig, GeocodeProvider } from './types'

/** 语言可配置，默认中文 */
export const DEFAULT_LANGUAGE = 'zh-CN'

/** 时区可配置，默认东 8 区（中国标准时间） */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 常用时区选项；值用 IANA 名，标签含城市与 UTC 偏移方便辨识。
 * 默认且置顶东 8 区，其余按 UTC 偏移升序排列。
 */
export const TIMEZONE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '北京 / 上海 (UTC+8)', value: 'Asia/Shanghai' },
  { label: '东京 (UTC+9)', value: 'Asia/Tokyo' },
  { label: '新加坡 (UTC+8)', value: 'Asia/Singapore' },
  { label: '伦敦 (UTC+0)', value: 'Europe/London' },
  { label: '纽约 (UTC-5)', value: 'America/New_York' },
  { label: '洛杉矶 (UTC-8)', value: 'America/Los_Angeles' },
  { label: '协调世界时 (UTC+0)', value: 'UTC' },
]

/** 把任意输入收敛到列表里的合法时区，非法或缺省回退东 8 区 */
export function normalizeTimezone(value: unknown): string {
  const raw = String(value ?? '').trim()
  if ((TIMEZONE_OPTIONS as Array<{ value: string }>).some((o) => o.value === raw)) {
    return raw
  }
  return DEFAULT_TIMEZONE
}

/** 地图服务商选项；值用 GeocodeProvider，标签随界面语言翻译 */
export const GEOCODE_PROVIDERS: Array<{ label: string; value: GeocodeProvider }> = [
  { label: '天地图', value: 'tianditu' },
  { label: '腾讯地图', value: 'tencent' },
  { label: '高德地图', value: 'amap' },
  { label: '百度地图', value: 'baidu' },
]

/** 默认位置服务：天地图，未填 Key 时回退到网关兜底配置 */
export const DEFAULT_GEOCODE: GeocodeConfig = { provider: 'tianditu', key: '' }

/** 把任意输入收敛到合法的地图服务商；非法或缺省回退天地图 */
export function normalizeGeocodeProvider(value: unknown): GeocodeProvider {
  const raw = String(value ?? '').trim()
  if ((GEOCODE_PROVIDERS as Array<{ value: string }>).some((o) => o.value === raw)) {
    return raw as GeocodeProvider
  }
  return DEFAULT_GEOCODE.provider
}

/** 网关默认 WebSocket 地址：H5 桌面调试直连本机网关 */
export const DEFAULT_GATEWAY_WS_URL = 'ws://127.0.0.1:8787/ws'

/** 把任意输入收敛成合法的网关 WebSocket 地址；空或非 ws(s) 协议回退默认 */
export function normalizeGatewayWsUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (/^wss?:\/\//i.test(raw)) return raw
  return DEFAULT_GATEWAY_WS_URL
}

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
