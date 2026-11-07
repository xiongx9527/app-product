/**
 * 天地图逆地理编码适配器。
 * 客户端用 uni.getLocation({type:'gcj02'}) 上报的是国测局偏移坐标（GCJ-02），
 * 而天地图 geocoder 接口按 WGS-84 / CGCS2000 解析，所以送之前先 gcj02→wgs84。
 * 依赖 tk（客户端上报或网关环境变量 TIANDITU_TK），且必须用「服务端」类型应用申请的 key，
 * 浏览器端 tk 会被 Referer/UA 校验拦掉。
 */

import type {
  Fetcher,
  ReverseGeocoder,
  ReverseGeocodeResult,
} from './types'

export type { Fetcher, ReverseGeocoder, ReverseGeocodeResult }

const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

function wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon }
  let dLat = transformLat(lon - 105.0, lat - 35.0)
  let dLon = transformLon(lon - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lon: lon + dLon }
}

/** GCJ-02（国测局）→ WGS-84：用近似逆变换消除国测局偏移。 */
export function gcj02ToWgs84(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon }
  const g = wgs84ToGcj02(lat, lon)
  return { lat: lat * 2 - g.lat, lon: lon * 2 - g.lon }
}

interface TiandituGeocoderResp {
  status?: string
  msg?: string
  result?: {
    formatted_address?: string
    addressComponent?: {
      address?: string
      city?: string
      road?: string
      poi?: string
    }
  }
}

/**
 * 创建一个天地图逆地理编码函数。tk 为空时直接返回 null（不联网），
 * 调用方据此退回客户端自带地址。
 */
export function createTiandituReverseGeocoder(
  tk: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): ReverseGeocoder {
  if (!tk) return async () => null
  return async (latitude: number, longitude: number) => {
    // 客户端给的是 gcj02，先转成天地图接口期望的 wgs84，避免几百米级偏移
    const { lat, lon } = gcj02ToWgs84(latitude, longitude)
    const postStr = JSON.stringify({ lon, lat, ver: 1 })
    const url =
      `https://api.tianditu.gov.cn/geocoder?postStr=${encodeURIComponent(postStr)}` +
      `&type=geocode&tk=${encodeURIComponent(tk)}`
    try {
      const res = await fetcher(url)
      if (!res.ok) return null
      const data = (await res.json()) as TiandituGeocoderResp
      if (data.status !== '0' || !data.result) return null
      const c = data.result.addressComponent ?? {}
      const formattedAddress = data.result.formatted_address ?? c.address ?? ''
      if (!formattedAddress) return null
      return {
        formattedAddress,
        city: c.city,
        road: c.road,
        poi: c.poi,
      }
    } catch {
      return null
    }
  }
}
