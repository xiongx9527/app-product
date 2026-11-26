import { describe, it, expect, vi } from 'vitest'
import { MediaControl } from '../../../src/service/media/mediaDetect'
import { MediaPlaybackCapability, type MediaPlaybackDeps } from '../../../src/service/media/MediaPlaybackCapability'
import type { ServerEvent } from '../../../src/protocol'

function makeCtrl(opts: { hasMedia?: boolean } = {}): {
  ctrl: MediaControl
  media: MediaPlaybackCapability
  events: ServerEvent[]
  spoken: string[]
} {
  const events: ServerEvent[] = []
  const spoken: string[] = []
  const deps: MediaPlaybackDeps = {
    send: (e) => events.push(e),
    ensureAdtsFile: async () => '',
    needsProxy: () => false,
    adtsKeyFor: (u) => u,
    getNowPlayingInfo: () => null,
  }
  const media = new MediaPlaybackCapability(deps)
  if (opts.hasMedia) media.play({ url: 'https://x/song.mp3', title: '稻香', artist: '周杰伦' })
  const ctrl = new MediaControl({
    media,
    lang: 'zh-CN',
    send: (e) => events.push(e),
    speak: async (t) => { spoken.push(t) },
  })
  return { ctrl, media, events, spoken }
}

describe('MediaControl：通用媒体控制（与内容 skill 无关）', () => {
  it('音量：调大/调小/设绝对值，调能力层', async () => {
    const { ctrl, media, events } = makeCtrl()
    expect(await ctrl.handle('调大音量')).toBe(true)
    expect(media.getVolume()).toBeCloseTo(0.6)
    expect(await ctrl.handle('调小音量')).toBe(true)
    expect(media.getVolume()).toBeCloseTo(0.5)
    expect(await ctrl.handle('音量调到30%')).toBe(true)
    expect(media.getVolume()).toBeCloseTo(0.3)
    expect(events.filter((e) => e.type === 'media.volume')).toHaveLength(3)
  })

  it('暂停/继续/停止：没在播如实说，不乱称', async () => {
    const { ctrl, spoken, events } = makeCtrl()
    expect(await ctrl.handle('暂停')).toBe(true)
    expect(spoken[0]).toContain('还没在播放')
    expect(events.some((e) => e.type === 'media.pause')).toBe(false)
  })

  it('有媒体时暂停不清 active（暂停≠停止），停止才清', async () => {
    const { ctrl, media, events } = makeCtrl({ hasMedia: true })
    await ctrl.handle('暂停')
    expect(events.some((e) => e.type === 'media.pause')).toBe(true)
    expect(media.snapshot().musicActive).toBe(true)
    await ctrl.handle('停止播放')
    expect(events.some((e) => e.type === 'media.stop')).toBe(true)
    expect(media.snapshot().musicActive).toBe(false)
  })

  it('播放模式：下发 client.playMode', async () => {
    const { ctrl, events } = makeCtrl()
    expect(await ctrl.handle('切换悬浮模式')).toBe(true)
    const pm = events.find((e) => e.type === 'client.playMode') as Extract<ServerEvent, { type: 'client.playMode' }>
    expect(pm.mode).toBe('float')
  })

  it('关字幕：本就没字幕如实说', async () => {
    const { ctrl, spoken, events } = makeCtrl()
    expect(await ctrl.handle('关闭字幕')).toBe(true)
    expect(spoken[0]).toContain('没有字幕')
    expect(events.some((e) => e.type === 'media.subtitle' && e.close)).toBe(true)
  })

  it('非通用控制句不消费（交内容 skill / LLM）', async () => {
    const { ctrl } = makeCtrl()
    expect(await ctrl.handle('放一首稻香')).toBe(false)
    expect(await ctrl.handle('你好')).toBe(false)
  })

  it('onStop 回调：停止时通知核心清新闻上下文', async () => {
    const onStop = vi.fn()
    const events: ServerEvent[] = []
    const spoken: string[] = []
    const media = new MediaPlaybackCapability({
      send: (e) => events.push(e), ensureAdtsFile: async () => '', needsProxy: () => false,
      adtsKeyFor: (u) => u, getNowPlayingInfo: () => null,
    })
    media.play({ url: 'https://x/a.mp3', title: '新闻' })
    const ctrl = new MediaControl({ media, lang: 'zh-CN', send: (e) => events.push(e), speak: async (t) => { spoken.push(t) }, onStop })
    await ctrl.handle('停止播放')
    expect(onStop).toHaveBeenCalledOnce()
  })
})
