/** 三类能力（音乐为网关内置能力，不再由客户端配置） */
export type Capability = 'asr' | 'llm' | 'tts'

/** 配置值只有这三种，方便存本地 JSON 与做类型收敛 */
export type ConfigValue = string | number | boolean

/**
 * 运行模式：
 * - byok：自带服务，用户自己填厂商、地址、Key（当前唯一可用）
 * - platform：平台托管，登录后付费用户直接使用平台 ASR / LLM / TTS，不需要任何配置
 */
export type ServiceMode = 'byok' | 'platform'

export interface ProviderField {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch' | 'textarea'
  placeholder?: string
  hint?: string
  options?: Array<{ label: string; value: string }>
  min?: number
  max?: number
  step?: number
}

/**
 * 一个厂商方案 = 厂商 + 默认参数 + 参数字段声明。
 * 配置页完全由 fields 渲染，新增厂商只加一份模板，不改页面代码。
 */
export interface ProviderTemplate {
  id: string
  /** 厂商名，选择器上显示 */
  vendor: string
  /** 具体方案，选中后在厂商名下方显示 */
  name: string
  description?: string
  defaults: Record<string, ConfigValue>
  fields: ProviderField[]
}

/** 每类能力一份配置：当前选中厂商 + 各厂商各自保存的参数 */
export interface CapabilityConfig {
  provider: string
  byProvider: Record<string, Record<string, ConfigValue>>
}

/** 地图服务商：逆地理编码（坐标→地址）用，均免费；坐标均走 GCJ-02（天地图除外，网关转 WGS-84） */
export type GeocodeProvider = 'tianditu' | 'tencent' | 'amap' | 'baidu'

/** 位置服务配置：选中的地图服务商 + 该服务商的 Key（byok，存本机） */
export interface GeocodeConfig {
  provider: GeocodeProvider
  key: string
}

export interface AppConfig {
  version: 1
  mode: ServiceMode
  /** 全局语言，ASR / TTS 没单独填时用它；唤醒识别也用 */
  language: string
  /** 全局时区（IANA，如 Asia/Shanghai）；时间类工具按它返回用户所在时区的时间，默认东 8 区 */
  timezone: string
  /** 位置服务（逆地理编码）：决定「我在哪」等问题的地址来源 */
  geocode: GeocodeConfig
  /** 网关调试地址：覆盖默认网关 WebSocket 地址，方便切换/联调；留空用默认 */
  gatewayWsUrl: string
  asr: CapabilityConfig
  llm: CapabilityConfig
  tts: CapabilityConfig
}
