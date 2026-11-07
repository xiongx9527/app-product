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
    const msg = await createMusicTool('zh-CN', source, emit).call({ genre: '轻音乐' })
    expect(directives).toEqual([{ type: 'media.play', ...sample }])
    expect(msg).toContain('歌A')
  })

  it('next_music 优先用 source.next 换一首，并下发 media.play', async () => {
    const nextTrack: ResolvedTrack = { url: 'https://x/2.mp3', title: '歌B', channel: 'soma' }
    const source: MusicSource = {
      resolve: async () => sample,
      next: async () => nextTrack,
    }
    const { directives, emit } = collect()
    const msg = await createNextMusicTool('zh-CN', source, emit).call({ genre: '爵士' })
    expect(directives).toEqual([{ type: 'media.play', ...nextTrack }])
    expect(msg).toContain('切换到')
  })

  it('next_music 在源没有 next 时回退到 resolve', async () => {
    const source: MusicSource = { resolve: async () => sample }
    const { directives, emit } = collect()
    await createNextMusicTool('zh-CN', source, emit).call({})
    expect(directives).toEqual([{ type: 'media.play', ...sample }])
  })

  it('英文文案按 lang 返回', async () => {
    const { emit } = collect()
    const pauseEn = await createPauseMusicTool('en-US', emit).call()
    expect(pauseEn).toBe('Music paused.')
  })
})
