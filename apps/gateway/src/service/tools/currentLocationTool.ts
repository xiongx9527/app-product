import { z } from 'zod'
import type { Lang, LocationInfo } from '../../protocol'
import type { ReverseGeocoder } from '../geocode/tiandituReverse'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const LOCATION_TOOL_NAME = 'get_current_location'

/** 位置提供方：返回会话最近一次上报的设备位置，未获取到时为 null。 */
export type LocationProvider = () => LocationInfo | null

/** 把位置格式化成可读字符串交给大模型；loc 为 null 时说明设备未授权/不可用。 */
export function formatLocation(lang: Lang | string, loc: LocationInfo | null): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
    if (prefix === 'en') return 'Current location is unavailable (device denied or no GPS).'
    return '当前位置未获取到（设备未授权定位或暂无 GPS 信号）。'
  }
  const lat = loc.latitude.toFixed(4)
  const lng = loc.longitude.toFixed(4)
  const where = loc.address ? loc.address : ''
  if (prefix === 'en') {
    return where
      ? `Current location: ${where} (lat ${lat}, lng ${lng}).`
      : `Device location: lat ${lat}, lng ${lng}.`
  }
  return where
    ? `当前位置：${where}（纬度 ${lat}，经度 ${lng}）`
    : `纬度 ${lat}，经度 ${lng}（来自设备定位）`
}

/** 工具描述随语言本地化，让对应语言的模型也能正确调用。 */
const DESCRIPTIONS: Record<string, string> = {
  zh: '获取设备当前位置（经纬度、城市/地址）。当用户问“我在哪”“附近”“现在的位置”等位置相关问题时调用此工具，不要凭记忆回答。',
  en: "Get the device's current location (latitude, longitude, city/address). Call whenever the user asks where they are or about nearby places; do not answer from memory.",
}

/**
 * 创建「获取当前位置」工具；无需入参，位置来自客户端上报、由 locationProvider 实时读取。
 * 若提供 reverseGeocoder（已配置天地图 tk），则用它把经纬度翻成更准的中文地址，
 * 失败时退回客户端自带地址；未配置时直接用客户端地址。
 * 返回 AgentScope 的 Tool 描述（name / description / inputSchema / call）。
 */
export function createCurrentLocationTool(
  lang: Lang | string,
  locationProvider: LocationProvider,
  reverseGeocoder?: ReverseGeocoder
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: LOCATION_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({}),
    call: async (): Promise<string> => {
      const loc = locationProvider()
      if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
        return formatLocation(lang, null)
      }
      // 有天地图 tk 时优先用服务端逆地理编码补全地址，更准且跨端一致
      if (reverseGeocoder) {
        try {
          const rev = await reverseGeocoder(loc.latitude, loc.longitude)
          if (rev?.formattedAddress) {
            return formatLocation(lang, { ...loc, address: rev.formattedAddress })
          }
        } catch {
          /* 退回客户端地址 */
        }
      }
      return formatLocation(lang, loc)
    },
  }
}
