import { describe, expect, it } from 'vitest'
import { formatTime } from './time'

describe('formatTime', () => {
  it('分秒格式并补零', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(605)).toBe('10:05')
  })

  it('超过一小时带上小时', () => {
    expect(formatTime(3661)).toBe('1:01:01')
  })

  it('非法值回退 0:00', () => {
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00')
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-3)).toBe('0:00')
  })
})
