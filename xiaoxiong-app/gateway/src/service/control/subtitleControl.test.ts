import { describe, it, expect } from 'vitest'
import { detectSubtitleCommand } from './subtitleControl'

describe('detectSubtitleCommand', () => {
  it('关闭类：关闭字幕 / 关字幕 / 不要字幕 / 隐藏字幕 → off', () => {
    expect(detectSubtitleCommand('关闭字幕')).toBe('off')
    expect(detectSubtitleCommand('关掉字幕')).toBe('off')
    expect(detectSubtitleCommand('字幕关了')).toBe('off')
    expect(detectSubtitleCommand('不要字幕')).toBe('off')
    expect(detectSubtitleCommand('隐藏歌词')).toBe('off')
    expect(detectSubtitleCommand('关闭歌词')).toBe('off')
    expect(detectSubtitleCommand('把字幕关了')).toBe('off')
  })

  it('开启类：开启字幕 / 显示字幕 / 我要看字幕 → on', () => {
    expect(detectSubtitleCommand('开启字幕')).toBe('on')
    expect(detectSubtitleCommand('打开歌词')).toBe('on')
    expect(detectSubtitleCommand('显示歌词')).toBe('on')
    expect(detectSubtitleCommand('显示字幕')).toBe('on')
    expect(detectSubtitleCommand('我要看字幕')).toBe('on')
  })

  it('仅含名词的问句不命中（交给大模型）', () => {
    expect(detectSubtitleCommand('字幕是什么')).toBeNull()
    expect(detectSubtitleCommand('这首歌的字幕很好看')).toBeNull()
  })

  it('与音乐/普通对话不冲突', () => {
    expect(detectSubtitleCommand('播放周杰伦的稻香')).toBeNull()
    expect(detectSubtitleCommand('今天天气怎么样')).toBeNull()
    expect(detectSubtitleCommand('')).toBeNull()
  })
})
