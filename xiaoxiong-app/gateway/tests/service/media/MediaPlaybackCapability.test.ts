import { describe, it, expect, vi } from 'vitest'
import { MediaPlaybackCapability, type MediaAsset, type MediaPlaybackDeps } from '../../../src/service/media/mediaPlaybackCapability'
import type { ServerEvent } from '../../../src/protocol'

function makeCap(overrides: Partial<MediaPlaybackDeps> = {}): {
  cap: MediaPlaybackCapability
  events: ServerEvent[]
  deps: MediaPlaybackDeps
} {
  const events: ServerEvent[] = []
  const deps: MediaPlaybackDeps = {
    send: (e) => { events.push(e) },
    ensureAdtsFile: vi.fn(async () => '/tmp/x.aac'),
    needsProxy: () => false,
    adtsKeyFor: (raw) => 'k-' + raw.length,
    getNowPlayingInfo: () => null,
    ...overrides,
  }
  return { cap: new MediaPlaybackCapability(deps), events, deps }
}

const musicAsset: MediaAsset = { url: 'https://x/song.mp3', title: '稻香', artist: '周杰伦', contentType: '歌曲' }
const ttsAsset: MediaAsset = { url: 'https://x/baike.mp3', title: '李存勖', source: 'tts', audioPath: 'media/s/a.mp3', lines: [{ time: 0, text: '李存勖' }] }

describe('MediaPlaybackCapability：纯系统能力', () => {
  it('play(music)：下发 media.play，不生成字幕', () => {
    const { cap, events } = makeCap()
    cap.play(musicAsset)
    expect(events.some((e) => e.type === 'media.play')).toBe(true)
    expect(events.some((e) => e.type === 'media.subtitle')).toBe(false)
    expect(cap.snapshot().musicActive).toBe(true)
  })

  it('confirm 口播不 await（speak 返回永不 resolve 也不阻塞 play）', () => {
    const { cap, events } = makeCap()
    const speak = vi.fn(() => new Promise<void>(() => undefined))
    // 不 await play 也不卡住：play 是同步返回
    cap.play(musicAsset, { confirm: '好的', speak })
    expect(speak).toHaveBeenCalledWith('好的')
    expect(events.some((e) => e.type === 'media.play')).toBe(true)
  })

  it('dash 音轨走本地 ADTS 短链 + proxy:false，且后台预热不阻塞', () => {
    const ensure = vi.fn(async () => '/tmp/x.aac')
    const { cap, events } = makeCap({ needsProxy: () => true, ensureAdtsFile: ensure })
    cap.play({ ...musicAsset, url: 'https://x/a.m4s', channel: 'bilibili' })
    const play = events.find((e) => e.type === 'media.play') as Extract<ServerEvent, { type: 'media.play' }>
    expect(play.proxy).toBe(false)
    expect(play.audioPath).toMatch(/^music\/s\//)
    expect(ensure).toHaveBeenCalled()
  })

  it('TTS 字幕原样下发（本层不生成不重算）', () => {
    const { cap, events } = makeCap()
    cap.play(ttsAsset)
    const sub = events.find((e) => e.type === 'media.subtitle') as Extract<ServerEvent, { type: 'media.subtitle' }>
    expect(sub.lines).toEqual([{ time: 0, text: '李存勖' }])
    expect(cap.snapshot().ttsMediaActive).toBe(true)
  })

  it('reuse 字幕：复用上次成功的行，不被空 lines 覆盖', () => {
    const { cap, events } = makeCap()
    cap.play(ttsAsset)
    cap.emitSubtitle('李存勖', undefined, [], true)
    const subs = events.filter((e) => e.type === 'media.subtitle') as Array<Extract<ServerEvent, { type: 'media.subtitle' }>>
    expect(subs.at(-1)?.lines).toEqual([{ time: 0, text: '李存勖' }])
  })

  it('pause/resume 不清 active（暂停≠停止）', () => {
    const { cap } = makeCap()
    cap.play(musicAsset)
    expect(cap.pause()).toBe(true)
    expect(cap.snapshot().musicActive).toBe(true)
    expect(cap.resume()).toBe(true)
    expect(cap.snapshot().musicActive).toBe(true)
  })

  it('stop 一次清全部状态', () => {
    const { cap } = makeCap()
    cap.play(ttsAsset)
    cap.emitSubtitle('李存勖', undefined, [{ time: 0, text: '李存勖' }])
    expect(cap.stop()).toBe(true)
    const s = cap.snapshot()
    expect(s.musicActive).toBe(false)
    expect(s.ttsMediaActive).toBe(false)
    expect(s.subtitleActive).toBe(false)
  })

  it('没在播放时 pause/stop/replay 都返回 false（诚实反馈）', () => {
    const { cap } = makeCap()
    expect(cap.pause()).toBe(false)
    expect(cap.stop()).toBe(false)
    expect(cap.replay()).toBe(false)
  })

  it('replay：tts 优先于 music', () => {
    const { cap, events } = makeCap()
    cap.play(musicAsset)
    cap.play(ttsAsset)
    expect(cap.replay()).toBe(true)
    const plays = events.filter((e) => e.type === 'media.play') as Array<Extract<ServerEvent, { type: 'media.play' }>>
    expect(plays.at(-1)?.title).toBe('李存勖')
  })

  it('reset 清状态（防跨会话残留）', () => {
    const { cap } = makeCap()
    cap.play(ttsAsset)
    cap.reset()
    expect(cap.snapshot().current).toBeNull()
    expect(cap.snapshot().ttsMediaActive).toBe(false)
  })
})


describe('MediaPlaybackCapability：高层语义方法（解析也是系统能力）', () => {
  const resolved: MediaAsset = { url: 'https://x/song.mp3', title: '稻香', artist: '周杰伦' }

  it('playByQuery：只传语义参数，内部用注入的 resolver 解析并播放', async () => {
    const resolve = vi.fn(async () => resolved)
    const { cap, events } = makeCap({ resolver: { resolve } })
    const asset = await cap.playByQuery({ genre: '周杰伦' }, { confirm: '好的' })
    expect(resolve).toHaveBeenCalledWith({ genre: '周杰伦' })
    expect(asset?.title).toBe('稻香')
    expect(events.some((e) => e.type === 'media.play')).toBe(true)
  })

  it('resolver 没找到 → 不播放、返回 null', async () => {
    const { cap, events } = makeCap({ resolver: { resolve: async () => null } })
    const asset = await cap.playByQuery({ query: '不存在' })
    expect(asset).toBeNull()
    expect(events.some((e) => e.type === 'media.play')).toBe(false)
  })

  it('未注入 resolver → 高层方法返回 null（play(MediaAsset) 仍可用）', async () => {
    const { cap } = makeCap()
    expect(await cap.playByQuery({ genre: 'x' })).toBeNull()
    expect(await cap.nextAsset()).toBeNull()
  })

  it('nextAsset：优先 resolver.next，无则回退 resolve', async () => {
    const next = vi.fn(async () => ({ ...resolved, title: '青花瓷' }))
    const resolve = vi.fn(async () => resolved)
    const { cap } = makeCap({ resolver: { resolve, next } })
    const asset = await cap.nextAsset({ genre: '周杰伦' })
    expect(asset?.title).toBe('青花瓷')
    expect(next).toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('ensureSubtitle：拉同源字幕并下发；autoSubtitle 语义由调用方控制', async () => {
    const getSubtitle = vi.fn(async () => [{ time: 0, text: '歌词1' }])
    const { cap, events } = makeCap({ resolver: { resolve: async () => resolved, getSubtitle } })
    await cap.ensureSubtitle('稻香', '周杰伦')
    const sub = events.find((e) => e.type === 'media.subtitle') as Extract<ServerEvent, { type: 'media.subtitle' }>
    expect(sub.lines).toEqual([{ time: 0, text: '歌词1' }])
  })
})
