import { describe, expect, it } from 'vitest'
import {
  elapsedLabel,
  elapsedSeconds,
  isSeekable,
  progressPercent,
  seekSeconds,
  totalLabel,
} from './musicProgress'

describe('播放器进度计算', () => {
  const song = { currentTime: 50, duration: 200, live: false }
  const radio = { currentTime: 42, duration: 0, live: true }

  it('歌曲可拖进度，百分比按已播/总时长算', () => {
    expect(isSeekable(song)).toBe(true)
    expect(progressPercent(song)).toBe(25)
  })

  it('歌曲时间标签：已播与总时长都显示', () => {
    expect(elapsedLabel(song)).toBe('0:50')
    expect(totalLabel(song)).toBe('3:20')
  })

  it('直播流不可拖，总时长留空', () => {
    expect(isSeekable(radio)).toBe(false)
    expect(progressPercent(radio)).toBe(0)
    expect(totalLabel(radio)).toBe('')
  })

  it('直播流仍显示已听时长', () => {
    expect(elapsedLabel(radio)).toBe('0:42')
  })

  it('拖动预览覆盖真实播放位置', () => {
    expect(progressPercent(song, 100)).toBe(50)
    expect(elapsedLabel(song, 100)).toBe('1:40')
    expect(elapsedSeconds(song, 0)).toBe(0)
  })

  it('百分比夹在 0~100', () => {
    expect(progressPercent({ currentTime: 999, duration: 200, live: false })).toBe(100)
    expect(progressPercent({ currentTime: -5, duration: 200, live: false })).toBe(0)
  })

  it('时长为 0 或非法时不当作可拖歌曲', () => {
    expect(isSeekable({ currentTime: 10, duration: 0, live: false })).toBe(false)
    expect(isSeekable({ currentTime: 10, duration: Number.NaN, live: false })).toBe(false)
    expect(isSeekable({ currentTime: 10, duration: Number.POSITIVE_INFINITY, live: false })).toBe(
      false
    )
  })

  it('滑块百分比换算成秒并收敛越界值', () => {
    expect(seekSeconds(50, 200)).toBe(100)
    expect(seekSeconds(0, 200)).toBe(0)
    expect(seekSeconds(120, 200)).toBe(200)
    expect(seekSeconds(-10, 200)).toBe(0)
    expect(seekSeconds(50, 0)).toBe(0)
  })

  it('未知时长时已播时间回落到 0', () => {
    expect(elapsedSeconds({ currentTime: Number.NaN, duration: 0, live: true })).toBe(0)
    expect(elapsedLabel({ currentTime: -1, duration: 0, live: true })).toBe('0:00')
  })
})
