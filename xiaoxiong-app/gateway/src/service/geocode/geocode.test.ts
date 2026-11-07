import { describe, it, expect } from 'vitest'
import {
  createGeocodeAdapter,
  createTencentGeocoder,
  createAmapGeocoder,
  createTiandituReverseGeocoder,
  createBaiduGeocoder,
  gcj02ToWgs84,
} from './index'
import type { Fetcher } from './types'

function jsonFetcher(payload: unknown): Fetcher {
  return async () => ({ ok: true, json: async () => payload })
}

describe('geocode adapters', () => {
  it('gcj02ToWgs84 消除国测局偏移（北京附近约几百米）', () => {
    const wgs = gcj02ToWgs84(39.9087, 116.3975)
    expect(wgs.lat).toBeLessThan(39.9087)
    expect(wgs.lon).toBeLessThan(116.3975)
    expect(39.9087 - wgs.lat).toBeLessThan(0.01)
    expect(116.3975 - wgs.lon).toBeLessThan(0.01)
  })

  it('天地图：gcj02 转 wgs84 后请求，解析返回', async () => {
    const fetcher = async (url: string) => {
      // 腾讯/高德直接吃 gcj02；天地图需要先转 wgs84，url 里的纬度应更小
      const decoded = decodeURIComponent(url)
      expect(decoded).toContain('api.tianditu.gov.cn/geocoder')
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
    const geocoder = createTiandituReverseGeocoder('TK', fetcher)
    const res = await geocoder(39.9087, 116.3975)
    expect(res?.formattedAddress).toBe('北京市西城区西什库大街31号院')
    expect(res?.city).toBe('北京市西城区')
  })

  it('天地图返回错误状态码时返回 null', async () => {
    const geocoder = createTiandituReverseGeocoder(
      'TK',
      jsonFetcher({ status: '404', msg: 'error' })
    )
    expect(await geocoder(39.9, 116.4)).toBeNull()
  })

  it('腾讯：坐标顺序为 lat,lng（与高德相反），解析 recommend 地址', async () => {
    const fetcher = async (url: string) => {
      expect(url).toContain('apis.map.qq.com/ws/geocoder/v1/')
      expect(decodeURIComponent(url)).toContain('location=31.23,121.47')
      return {
        ok: true,
        json: async () => ({
          status: 0,
          result: {
            formatted_addresses: { recommend: '上海市浦东新区世纪大道' },
            address_component: { city: '上海市', district: '浦东新区', street: '世纪大道' },
          },
        }),
      }
    }
    const geocoder = createTencentGeocoder('TK', fetcher)
    const res = await geocoder(31.23, 121.47)
    expect(res?.formattedAddress).toBe('上海市浦东新区世纪大道')
    expect(res?.city).toBe('上海市')
    expect(res?.road).toBe('世纪大道')
  })

  it('腾讯：recommend 缺失时退回 address', async () => {
    const geocoder = createTencentGeocoder(
      'TK',
      jsonFetcher({
        status: 0,
        result: { address: '上海市黄浦区南京东路', address_component: { city: '上海市' } },
      })
    )
    const res = await geocoder(31.23, 121.47)
    expect(res?.formattedAddress).toBe('上海市黄浦区南京东路')
  })

  it('高德：坐标顺序为 lng,lat（与腾讯相反），解析 formatted_address', async () => {
    const fetcher = async (url: string) => {
      expect(url).toContain('restapi.amap.com/v3/geocode/regeo')
      expect(decodeURIComponent(url)).toContain('location=121.47,31.23')
      return {
        ok: true,
        json: async () => ({
          status: '1',
          regeocode: {
            formatted_address: '上海市浦东新区世纪大道100号',
            addressComponent: { city: '上海市', district: '浦东新区', street: '世纪大道' },
          },
        }),
      }
    }
    const geocoder = createAmapGeocoder('TK', fetcher)
    const res = await geocoder(31.23, 121.47)
    expect(res?.formattedAddress).toBe('上海市浦东新区世纪大道100号')
    expect(res?.city).toBe('上海市')
  })

  it('高德：city 为数组时取首元素', async () => {
    const geocoder = createAmapGeocoder(
      'TK',
      jsonFetcher({
        status: '1',
        regeocode: {
          formatted_address: '北京市朝阳区',
          addressComponent: { city: ['北京市'], district: '朝阳区' },
        },
      })
    )
    const res = await geocoder(39.9, 116.4)
    expect(res?.city).toBe('北京市')
  })

  it('三家：key 为空时返回 null（不联网）', async () => {
    expect(await createTiandituReverseGeocoder('')(39.9, 116.4)).toBeNull()
    expect(await createTencentGeocoder('')(39.9, 116.4)).toBeNull()
    expect(await createAmapGeocoder('')(39.9, 116.4)).toBeNull()
    expect(await createBaiduGeocoder('')(39.9, 116.4)).toBeNull()
  })

  it('百度：坐标顺序为 lat,lng（与腾讯一致），coordtype=gcj02ll，status 0 解析地址', async () => {
    const fetcher = async (url: string) => {
      expect(url).toContain('api.map.baidu.com/reverse_geocoding/v3/')
      expect(decodeURIComponent(url)).toContain('location=31.23,121.47')
      expect(decodeURIComponent(url)).toContain('coordtype=gcj02ll')
      return {
        ok: true,
        json: async () => ({
          status: 0,
          result: {
            formatted_address: '上海市浦东新区世纪大道100号',
            addressComponent: { city: '上海市', district: '浦东新区', street: '世纪大道' },
          },
        }),
      }
    }
    const geocoder = createBaiduGeocoder('TK', fetcher)
    const res = await geocoder(31.23, 121.47)
    expect(res?.formattedAddress).toBe('上海市浦东新区世纪大道100号')
    expect(res?.city).toBe('上海市')
  })

  it('百度：status 非 0 时返回 null', async () => {
    const geocoder = createBaiduGeocoder(
      'TK',
      jsonFetcher({ status: 1, message: 'AK 错误' })
    )
    expect(await geocoder(39.9, 116.4)).toBeNull()
  })

  it('createGeocodeAdapter 按 provider 选适配器；空 key 返回 null', async () => {
    const tenc = createGeocodeAdapter({ provider: 'tencent', key: 'K' })
    expect(typeof tenc).toBe('function')
    const baidu = createGeocodeAdapter({ provider: 'baidu', key: 'K' })
    expect(typeof baidu).toBe('function')
    const nulled = createGeocodeAdapter({ provider: 'amap', key: '' })
    expect(nulled).toBeNull()
  })
})
