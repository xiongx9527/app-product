/** 反向地理编码（坐标 → 地址）相关的类型与适配器抽象。 */

/** 支持的地图服务商。均提供免费的逆地理编码接口。 */
export type GeocodeProviderKind = 'tianditu' | 'tencent' | 'amap' | 'baidu'

/** 客户端上报的地图配置：选中的服务商 + 该服务商的 Key（byok，存本机）。 */
export interface GeocodeConfig {
  provider: GeocodeProviderKind
  key: string
}

/** 逆地理编码结果（各服务商返回的结构化地址统一成这个形状）。 */
export interface ReverseGeocodeResult {
  /** 完整可读地址，如「北京市西城区西什库大街31号院」 */
  formattedAddress: string
  /** 城市/区县，如「北京市西城区」 */
  city?: string
  /** 所在道路 */
  road?: string
  /** 最近的 POI 名称 */
  poi?: string
}

/** 逆地理编码函数：经纬度 → 地址；失败/未配置时返回 null。 */
export type ReverseGeocoder = (
  latitude: number,
  longitude: number
) => Promise<ReverseGeocodeResult | null>

/** 可注入的网络请求，便于测试；默认全局 fetch。 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
