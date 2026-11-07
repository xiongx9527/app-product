/**
 * 腾讯位置服务逆地理编码适配器。
 * 腾讯接口使用 GCJ-02 坐标系，与客户端 uni.getLocation({type:'gcj02'}) 上报的一致，无需坐标转换。
 * 注意坐标顺序：location=纬度,经度（lat,lng）。
 * 免费额度：个人开发者约 6000 次/日；服务端调用需在控制台配 IP 白名单。
 */

import type { Fetcher, ReverseGeocoder } from './types'

interface TencentGeocoderResp {
  status?: number
  message?: string
  result?: {
    formatted_addresses?: { recommend?: string; standard_address?: string }
    address?: string
    address_component?: {
      city?: string
      district?: string
      street?: string
    }
  }
}

/**
 * 创建腾讯逆地理编码函数。key 为空时返回 null（不联网）；
 * 调用方据此退回客户端自带地址。
 */
export function createTencentGeocoder(
  key: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): ReverseGeocoder {
  if (!key) return async () => null
  return async (latitude: number, longitude: number) => {
    // 腾讯：location=lat,lng，坐标系 GCJ-02（与客户端一致）
    const url =
      `https://apis.map.qq.com/ws/geocoder/v1/?location=${latitude},${longitude}` +
      `&get_poi=0&key=${encodeURIComponent(key)}`
    try {
      const res = await fetcher(url)
      if (!res.ok) return null
      const data = (await res.json()) as TencentGeocoderResp
      if (data.status !== 0 || !data.result) return null
      const r = data.result
      const formattedAddress =
        r.formatted_addresses?.recommend ||
        r.formatted_addresses?.standard_address ||
        r.address ||
        ''
      if (!formattedAddress) return null
      return {
        formattedAddress,
        city: r.address_component?.city || r.address_component?.district,
        road: r.address_component?.street,
      }
    } catch {
      return null
    }
  }
}
