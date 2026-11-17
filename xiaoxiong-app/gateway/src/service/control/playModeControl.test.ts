import { describe, it, expect } from 'vitest'
import { detectPlayModeCommand } from './playModeControl'

describe('detectPlayModeCommand', () => {
  it('通用切换：切换播放模式 / 换个播放模式 / 切换模式 → toggle', () => {
    expect(detectPlayModeCommand('切换播放模式')).toBe('toggle')
    expect(detectPlayModeCommand('换个播放模式')).toBe('toggle')
    expect(detectPlayModeCommand('切换显示模式')).toBe('toggle')
    expect(detectPlayModeCommand('切换模式')).toBe('toggle')
  })

  it('明确切到悬浮：打开悬浮 / 切到悬浮 / 悬浮模式 → float', () => {
    expect(detectPlayModeCommand('打开悬浮')).toBe('float')
    expect(detectPlayModeCommand('切换悬浮')).toBe('float')
    expect(detectPlayModeCommand('切到悬浮模式')).toBe('float')
    expect(detectPlayModeCommand('用悬浮')).toBe('float')
  })

  it('明确切回播放器：关闭悬浮 / 切回播放器 / 播放器模式 → player', () => {
    expect(detectPlayModeCommand('关闭悬浮')).toBe('player')
    expect(detectPlayModeCommand('退出悬浮')).toBe('player')
    expect(detectPlayModeCommand('切回播放器')).toBe('player')
    expect(detectPlayModeCommand('播放器模式')).toBe('player')
  })

  it('不与点歌 / 换一首 / 字幕开关 / 普通对话冲突 → null', () => {
    expect(detectPlayModeCommand('播放周杰伦的稻香')).toBeNull()
    expect(detectPlayModeCommand('换一首')).toBeNull()
    expect(detectPlayModeCommand('换个风格')).toBeNull()
    expect(detectPlayModeCommand('关闭字幕')).toBeNull()
    expect(detectPlayModeCommand('今天天气怎么样')).toBeNull()
    expect(detectPlayModeCommand('')).toBeNull()
  })
})
