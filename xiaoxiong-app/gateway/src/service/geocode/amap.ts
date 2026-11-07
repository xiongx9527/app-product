/**
 * 高德地图逆地理编码适配器。
 * 高德接口使用 GCJ-02 坐标系，与客户端 uni.getLocation({type:'gcj02'}) 上报的一致，无需坐标转换。
 * 注意坐标顺序：location=经度,纬度（lng,lat，与腾讯相反）。
 * 免费额度：个人认证开发者充足（按官方为准）；服务端调用建议配 IP 白名单。
 */

import type { Fetcher, ReverseGeocoder } from './types'

interface AmapGeocoderResp {
  status?: string
  info?: string
  regeocode?: {
    formatted_address?: string
    addressComponent?: {
      city?: string | string[]
      district?: string
      street?: string
      township?: string
    }
  }
}

function asString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * 创建高德逆地理编码函数。key 为空时返回 null（不联网）；调用方据此退回客户端自带地址。
 */
export function createAmapGeocoder(
  key: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): ReverseGeocoder {
  if (!key) return async () => null
  return async (latitude: number, longitude: number) => {
    // 高德：location=lng,lat，坐标系 GCJ-02（与客户端一致）
    const url =
      `https://restapi.amap.com/v3/geocode/regeo?location=${longitude},${latitude}` +
      `&radius=1000&extensions=base&output=json&key=${encodeURIComponent(key)}`
    try {
      const res = await fetcher(url)
      if (!res.ok) return null
      const data = (await res.json()) as AmapGeocoderResp
      if (data.status !== '1' || !data.regeocode) return null
      const formattedAddress = data.regeocode.formatted_address ?? ''
      if (!formattedAddress) return null
      const c = data.regeocode.addressComponent ?? {}
      return {
        formattedAddress,
        city: asString(c.city) || c.district,
        road: c.street || c.township,
      }
    } catch {
      return null
    }
  }
}
