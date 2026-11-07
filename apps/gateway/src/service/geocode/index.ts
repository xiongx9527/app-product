/**
 * 反向地理编码适配器工厂：按客户端上报（或网关兜底）的配置构造对应的逆地理编码函数。
 * 三家服务商坐标/参数顺序各不相同，由各自适配器内部消化，对外统一成 ReverseGeocoder。
 */

import type { Fetcher, GeocodeConfig, ReverseGeocoder } from './types'
import { createTiandituReverseGeocoder } from './tiandituReverse'
import { createTencentGeocoder } from './tencent'
import { createAmapGeocoder } from './amap'

export {
  createTiandituReverseGeocoder,
  gcj02ToWgs84,
} from './tiandituReverse'
export {
  createTencentGeocoder,
} from './tencent'
export { createAmapGeocoder } from './amap'
export type {
  Fetcher,
  GeocodeConfig,
  GeocodeProviderKind,
  ReverseGeocoder,
  ReverseGeocodeResult,
} from './types'

/** 按配置构造逆地理编码函数；key 为空时返回 null（不联网）。 */
export function createGeocodeAdapter(
  config: GeocodeConfig,
  fetcher?: Fetcher
): ReverseGeocoder | null {
  if (!config?.key) return null
  switch (config.provider) {
    case 'tencent':
      return createTencentGeocoder(config.key, fetcher)
    case 'amap':
      return createAmapGeocoder(config.key, fetcher)
    case 'tianditu':
    default:
      return createTiandituReverseGeocoder(config.key, fetcher)
  }
}
