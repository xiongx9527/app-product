import { describe, it, expect } from 'vitest'
import {
  createCurrentLocationTool,
  formatLocation,
  LOCATION_TOOL_NAME,
} from './currentLocationTool'
import {
  createTiandituReverseGeocoder,
  gcj02ToWgs84,
  type ReverseGeocoder,
} from '../geocode/tiandituReverse'

describe('currentLocationTool', () => {
  it('工具名固定、描述随语言本地化', () => {
    expect(createCurrentLocationTool('zh-CN', () => null).name).toBe(LOCATION_TOOL_NAME)
    expect(createCurrentLocationTool('zh-CN', () => null).description).toContain('位置')
    expect(
      createCurrentLocationTool('en-US', () => null).description.toLowerCase()
    ).toContain('location')
  })

  it('未获取到位置时返回说明文案', () => {
    expect(formatLocation('zh-CN', null)).toContain('未获取')
    expect(formatLocation('en-US', null)).toMatch(/unavailable/i)
  })

  it('有地址时返回地址与经纬度', () => {
    const loc = { latitude: 39.9042, longitude: 116.4074, address: '北京市朝阳区' }
    expect(formatLocation('zh-CN', loc)).toContain('北京市朝阳区')
    expect(formatLocation('zh-CN', loc)).toContain('39.9042')
  })

  it('call 实时读取 provider 返回的最新位置', async () => {
    let store: { latitude: number; longitude: number } | null = {
      latitude: 31.23,
      longitude: 121.47,
    }
    const provider = () => store
    const tool = createCurrentLocationTool('zh-CN', provider)
    expect(await tool.call?.()).toContain('31.2300')
    store = null
    expect(await tool.call?.()).toContain('未获取')
  })

  it('配置了逆地理编码时优先用服务端地址', async () => {
    const provider = () => ({ latitude: 39.9042, longitude: 116.4074, address: '客户端自带地址' })
    const reverseGeocoder: ReverseGeocoder = async () => ({
      formattedAddress: '北京市东城区天安门',
      city: '北京市东城区',
    })
    const tool = createCurrentLocationTool('zh-CN', provider, reverseGeocoder)
    const out = await tool.call?.()
    expect(out).toContain('北京市东城区天安门')
    expect(out).not.toContain('客户端自带地址')
  })

  it('逆地理编码失败时退回客户端地址', async () => {
    const provider = () => ({ latitude: 39.9042, longitude: 116.4074, address: '客户端自带地址' })
    const reverseGeocoder: ReverseGeocoder = async () => null
    const tool = createCurrentLocationTool('zh-CN', provider, reverseGeocoder)
    expect(await tool.call?.()).toContain('客户端自带地址')
  })

  it('gcj02ToWgs84 消除国测局偏移（北京附近约几百米）', () => {
    // 天安门附近 gcj02 坐标，转 wgs84 后纬度应略小、经度略小
    const wgs = gcj02ToWgs84(39.9087, 116.3975)
    expect(wgs.lat).toBeLessThan(39.9087)
    expect(wgs.lon).toBeLessThan(116.3975)
    // 偏移量级在合理范围内（米级到百米级）
    expect(39.9087 - wgs.lat).toBeLessThan(0.01)
    expect(116.3975 - wgs.lon).toBeLessThan(0.01)
  })

  it('createTiandituReverseGeocoder 无 tk 时直接返回 null', async () => {
    const geocoder = createTiandituReverseGeocoder('')
    expect(await geocoder(39.9, 116.4)).toBeNull()
  })

  it('createTiandituReverseGeocoder 解析天地图返回并转坐标', async () => {
    const fetcher = async (url: string) => {
      expect(url).toContain('api.tianditu.gov.cn/geocoder')
      expect(url).toContain('type=geocode')
      // postStr 经过 URL 编码，解码后应是 wgs84 坐标（lat 比传入的 gcj02 略小）
      const decoded = decodeURIComponent(url)
      expect(decoded).toContain('"lat":')
      return {
        ok: true,
        json: async () => ({
          status: '0',
          result: {
            formatted_address: '北京市西城区西什库大街31号院',
            addressComponent: { city: '北京市西城区', road: '大红罗厂街' },
          },
        }),
      }
    }
    const geocoder = createTiandituReverseGeocoder('TEST_TK', fetcher)
    const res = await geocoder(39.9087, 116.3975)
    expect(res?.formattedAddress).toBe('北京市西城区西什库大街31号院')
    expect(res?.city).toBe('北京市西城区')
  })

  it('createTiandituReverseGeocoder 天地图返回错误时返回 null', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({ status: '404', msg: 'error' }),
    })
    const geocoder = createTiandituReverseGeocoder('TEST_TK', fetcher)
    expect(await geocoder(39.9, 116.4)).toBeNull()
  })
})
