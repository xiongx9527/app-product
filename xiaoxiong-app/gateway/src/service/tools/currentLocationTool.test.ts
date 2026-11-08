import { describe, it, expect } from 'vitest'
import {
  createCurrentLocationTool,
  formatLocation,
  LOCATION_TOOL_NAME,
} from './currentLocationTool'

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

  it('懒加载：provider 暂无位置但有 requestLocation 时，等待客户端上报后再返回', async () => {
    let loc: { latitude: number; longitude: number; address?: string } | null = null
    const provider = () => loc
    // requestLocation 模拟网关向客户端要位置、客户端上报后兑现
    const requestLocation = async () => {
      loc = { latitude: 22.54, longitude: 114.06, address: '深圳市南山区' }
      return loc
    }
    const tool = createCurrentLocationTool('zh-CN', provider, requestLocation)
    const out = await tool.call?.()
    expect(out).toContain('深圳市南山区')
    expect(out).toContain('22.5400')
  })

  it('懒加载：requestLocation 也拿不到位置时，回退到「未获取」文案', async () => {
    const provider = () => null
    const requestLocation = async () => null
    const tool = createCurrentLocationTool('zh-CN', provider, requestLocation)
    expect(await tool.call?.()).toContain('未获取')
  })
})
