import { describe, it, expect } from 'vitest'
import { detectWeatherCommand, extractWeatherCity } from './weatherControl'

describe('detectWeatherCommand', () => {
  it.each([
    '今天天气怎么样',
    '北京天气',
    '多少度',
    '会不会下雨',
  ])('命中：%s', (text) => {
    expect(detectWeatherCommand(text)).toBe(true)
  })
  it.each(['', '   ', '播放周杰伦的稻香'])('不命中：%s', (text) => {
    expect(detectWeatherCommand(text)).toBe(false)
  })
})

describe('extractWeatherCity（指定城市）', () => {
  it.each([
    ['北京天气怎么样', '北京'],
    ['查一下上海天气', '上海'],
    ['广州多少度', '广州'],
    ['帮我看看深圳的天气', '深圳'],
    ['成都天气', '成都'],
  ])('提取城市：%s → %s', (text, city) => {
    expect(extractWeatherCity(text)).toBe(city)
  })

  it.each([
    '今天天气怎么样',
    '天气怎么样',
    '多少度',
    '会不会下雨',
    '现在天气',
  ])('无城市名返回 null：%s', (text) => {
    expect(extractWeatherCity(text)).toBeNull()
  })
})
