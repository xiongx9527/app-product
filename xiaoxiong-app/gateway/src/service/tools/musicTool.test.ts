import { describe, it, expect } from 'vitest'
import {
  MUSIC_TOOL_NAME,
  STOP_MUSIC_TOOL_NAME,
  PAUSE_MUSIC_TOOL_NAME,
  RESUME_MUSIC_TOOL_NAME,
  NEXT_MUSIC_TOOL_NAME,
  createMusicTool,
  createStopMusicTool,
  createPauseMusicTool,
  createResumeMusicTool,
  createNextMusicTool,
  type MediaDirective,
} from './musicTool'
import type { MusicSource, ResolvedTrack } from '../music/types'
import { needsProxy } from '../music'

function collect(): { directives: MediaDirective[]; emit: (m: MediaDirective) => void } {
  const directives: MediaDirective[] = []
  return { directives, emit: (m) => directives.push(m) }
}

const sample: ResolvedTrack = { url: 'https://x/1.mp3', title: '歌A', channel: 'soma' }

describe('音乐控制工具', () => {
  it('工具名固定且不被本地化', () => {
    expect(MUSIC_TOOL_NAME).toBe('play_music')
    expect(STOP_MUSIC_TOOL_NAME).toBe('stop_music')
    expect(PAUSE_MUSIC_TOOL_NAME).toBe('pause_music')
    expect(RESUME_MUSIC_TOOL_NAME).toBe('resume_music')
    expect(NEXT_MUSIC_TOOL_NAME).toBe('next_music')
  })

  it('pause_music 下发 media.pause，无需网络', async () => {
    const { directives, emit } = collect()
    const msg = await createPauseMusicTool('zh-CN', emit).call()
    expect(directives).toEqual([{ type: 'media.pause' }])
    expect(msg).toContain('暂停')
  })

  it('resume_music 下发 media.resume', async () => {
    const { directives, emit } = collect()
    const msg = await createResumeMusicTool('zh-CN', emit).call()
    expect(directives).toEqual([{ type: 'media.resume' }])
    expect(msg).toContain('继续')
  })

  it('stop_music 下发 media.stop', async () => {
    const { directives, emit } = collect()
    await createStopMusicTool('zh-CN', emit).call()
    expect(directives).toEqual([{ type: 'media.stop' }])
  })

  it('play_music 下发 media.play 并带上解析出的曲目', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    const msg = await createMusicTool('zh-CN', () => source, emit).call({ genre: '轻音乐' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 3 },
    ])
    expect(msg).toContain('歌A')
  })

  it('play_music 搜不到时告知找不到且不下发 media.play（不乱播电台）', async () => {
    const source: MusicSource = { resolve: async () => { throw new Error('not found') } }
    const { directives, emit } = collect()
    const msg = await createMusicTool('zh-CN', () => source, emit).call({ genre: '不存在的歌' })
    expect(directives).toEqual([])
    expect(msg).toContain('没找到这首歌')
  })

  it('play_music 下发 SomaFM 风格电台时标记 proxy（原生 App UA 被拒需网关代拉）', async () => {
    const somaTrack: ResolvedTrack = {
      url: 'https://ice6.somafm.com/groovesalad-128-mp3',
      title: 'Groove Salad',
      channel: 'groovesalad',
    }
    const source: MusicSource = { resolve: async () => somaTrack }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit).call({ genre: '轻音乐' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...somaTrack, proxy: true, loop: 3 },
    ])
  })

  it('next_music 搜不到时也告知找不到且不下发 media.play', async () => {
    const source: MusicSource = {
      resolve: async () => sample,
      next: async () => { throw new Error('not found') },
    }
    const { directives, emit } = collect()
    const msg = await createNextMusicTool('zh-CN', () => source, emit).call({ genre: '不存在的歌' })
    expect(directives).toEqual([])
    expect(msg).toContain('没找到这首歌')
  })

  it('next_music 优先用 source.next 换一首，并下发 media.play', async () => {
    const nextTrack: ResolvedTrack = { url: 'https://x/2.mp3', title: '歌B', channel: 'soma' }
    const source: MusicSource = {
      resolve: async () => sample,
      next: async () => nextTrack,
    }
    const { directives, emit } = collect()
    const msg = await createNextMusicTool('zh-CN', () => source, emit).call({ genre: '爵士' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...nextTrack, proxy: needsProxy(nextTrack.channel), loop: 3 },
    ])
    expect(msg).toContain('切换到')
  })

  it('next_music 在源没有 next 时回退到 resolve', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createNextMusicTool('zh-CN', () => source, emit).call({})
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 3 },
    ])
  })

  it('自动字幕开启：play_music 播放后同源拉取字幕并下发 media.subtitle', async () => {
    const subtitleLines = [
      { time: 1, text: '第一句' },
      { time: 5, text: '第二句' },
    ]
    const source: MusicSource = { resolve: async () => sample, getSubtitle: async () => subtitleLines }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit, true).call({ genre: '稻香' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 3 },
      { type: 'media.subtitle', title: sample.title, lines: subtitleLines },
    ])
  })

  it('自动字幕关闭：play_music 只下发 media.play，不下发 media.subtitle', async () => {
    const source: MusicSource = { resolve: async () => sample, getSubtitle: async () => [{ time: 1, text: '字幕' }] }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit, false).call({ genre: '稻香' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 3 },
    ])
  })

  it('自动字幕开启（源无 getSubtitle）：play_music 只下发 media.play，不下发空字幕', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit, true).call({ genre: '稻香' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 3 },
    ])
  })

  it('next_music 自动字幕开启：换歌后也同源拉取字幕并下发 media.subtitle', async () => {
    const nextTrack: ResolvedTrack = { url: 'https://x/2.mp3', title: '歌B', channel: 'soma' }
    const subtitleLines = [{ time: 3, text: 'X' }]
    const source: MusicSource = {
      resolve: async () => sample,
      next: async () => nextTrack,
      getSubtitle: async () => subtitleLines,
    }
    const { directives, emit } = collect()
    await createNextMusicTool('zh-CN', () => source, emit, true).call({ genre: '爵士' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...nextTrack, proxy: needsProxy(nextTrack.channel), loop: 3 },
      { type: 'media.subtitle', title: nextTrack.title, lines: subtitleLines },
    ])
  })

  it('英文文案按 lang 返回', async () => {
    const { emit } = collect()
    const pauseEn = await createPauseMusicTool('en-US', emit).call()
    expect(pauseEn).toBe('Music paused.')
  })

  it('play_music 尊重传入的 defaultLoop / defaultVolume：带入 loop 与 media.volume', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit, true, 2, 0.4).call({ genre: '轻音乐' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.4 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 2 },
    ])
  })

  it('next_music 尊重传入的 defaultLoop / defaultVolume', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createNextMusicTool('zh-CN', () => source, emit, true, 5, 0.7).call({})
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.7 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel), loop: 5 },
    ])
  })

  it('播放源不循环（defaultLoop=1）：play_music 不下发 loop 字段', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createMusicTool('zh-CN', () => source, emit, true, 1, 0.5).call({ genre: '轻音乐' })
    expect(directives).toEqual([
      { type: 'media.volume', volume: 0.5 },
      { type: 'media.play', ...sample, proxy: needsProxy(sample.channel) },
    ])
  })
})
