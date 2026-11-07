/**
 * 百度地图逆地理编码适配器。
 * 百度原生坐标系为 BD-09，但逆地理编码接口支持 coordtype=gcj02ll 直接接收 GCJ-02 坐标，
 * 与客户端 uni.getLocation({type:'gcj02'}) 上报的一致，无需坐标转换（避免 BD-09 偏移）。
 * 注意坐标顺序：location=纬度,经度（lat,lng），与腾讯一致、与高德相反。
 * 免费额度：个人开发者逆地理编码约 2000 次/日；服务端调用需在控制台配 IP 白名单（可选 SN 校验）。
 */

import type { Fetcher, ReverseGeocoder } from './types'

interface BaiduGeocoderResp {
  status?: number
  message?: string
  result?: {
    formatted_address?: string
    addressComponent?: {
      city?: string
      district?: string
      street?: string
    }
  }
}

/**
 * 创建百度逆地理编码函数。key 为空时返回 null（不联网）；
 * 调用方据此退回客户端自带地址。
 */
export function createBaiduGeocoder(
  key: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): ReverseGeocoder {
  if (!key) return async () => null
  return async (latitude: number, longitude: number) => {
    // 百度：location=lat,lng；coordtype=gcj02ll 声明输入是 GCJ-02，避免 BD-09 偏移
    const url =
      'https://api.map.baidu.com/reverse_geocoding/v3/' +
      `?ak=${encodeURIComponent(key)}&output=json&coordtype=gcj02ll` +
      `&location=${latitude},${longitude}`
    try {
      const res = await fetcher(url)
      if (!res.ok) return null
      const data = (await res.json()) as BaiduGeocoderResp
      // 百度 status 0 表示成功
      if (data.status !== 0 || !data.result) return null
      const r = data.result
      const formattedAddress = r.formatted_address || ''
      if (!formattedAddress) return null
      return {
        formattedAddress,
        city: r.addressComponent?.city || r.addressComponent?.district,
        road: r.addressComponent?.street,
      }
    } catch {
      return null
    }
  }
}
