/** 天气数据源域：可换源（默认 wttr.in，备选 open-meteo）。 */
import type { WeatherSource } from './types'
import { createWttrSource } from './wttrSource'

export type { WeatherPayload, WeatherFetcher, WeatherSource } from './types'
export { createWttrSource, parseWttrWeather } from './wttrSource'
export { createOpenMeteoSource } from './openMeteoSource'

/**
 * 默认天气源工厂——换源的唯一切换点。
 * 需要换源（如海外环境改用 open-meteo）时，只改这里一行，工具层与天气直连同时生效；
 * 也可在组合根显式注入别的 WeatherSource 覆盖（createWeatherTool 的第 3 参）。
 */
export function createDefaultWeatherSource(): WeatherSource {
  return createWttrSource()
}
