/**
 * 天气数据源的抽象契约。
 *
 * 「可换源」：天气工具只依赖 WeatherSource 接口，不绑定任何具体站点。
 * 以后要换源（国内/海外、免费/付费）只需实现这个接口并在组合根注入，
 * 不用改 weatherTool 的取数/格式化逻辑。当前默认实现见 wttrSource.ts。
 *
 * 设计参照 deals 的 DealsSource：source 负责「去哪取 + 怎么解析成统一结构」，
 * 工具层负责「拿统一结构格式化成口播文案」，两者解耦。
 */

/** 统一中间结构：任何天气源都把原始响应解析成这个形状，格式化层只认它。 */
export interface WeatherPayload {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    /** WMO 天气代码（0/1/2/3/45/51/61/…），各源负责把自家编码换算过来。 */
    weather_code?: number
    /** 风速，单位 m/s。 */
    wind_speed_10m?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: number[]
  }
}

/** 底层 HTTP 拉取函数：默认全局 fetch，测试可注入桩，避免真实联网。 */
export type WeatherFetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/**
 * 天气源接口：给定经纬度取回统一结构；失败返回 null（由工具层给友好兜底文案）。
 * fetcher 由工具层注入，source 不直接依赖全局 fetch，便于测试。
 */
export interface WeatherSource {
  /** 数据源标识，仅用于日志/调试，不向用户暴露。 */
  name: string
  fetch(lat: number, lng: number, fetcher: WeatherFetcher): Promise<WeatherPayload | null>
}
