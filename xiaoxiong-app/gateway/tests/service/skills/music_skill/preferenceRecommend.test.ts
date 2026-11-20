import { describe, it, expect, vi } from 'vitest'
import { MusicPlayer } from '../../../../src/service/skills/music_skill/player'
import type { ContentExecutorDeps } from '../../../../src/service/content/types'

/**
 * 无明确内容时结合长期记忆偏好推荐（列候选让用户选），绝不自动播默认电台 Groove Salad。
 * 真机踩坑：说「看。」（噪音单字）/「放首歌」竟自动播了 Groove Salad，用户要求改为引导+偏好推荐。
 */
function makePlayer(opts: {
  prefs: string[]
  candidates: Array<{ title: string; artist?: string }>
}): { player: MusicPlayer; spoken: string[]; resolve: ReturnType<typeof vi.fn>; sent: unknown[] } {
  const spoken: string[] = []
  const sent: unknown[] = []
  const resolve = vi.fn(async () => ({ url: 'https://somafm.com/groovesalad', title: 'Groove Salad' }))
  const source = { resolve, kind: 'test' } as any
  const deps: ContentExecutorDeps = {
    lang: () => 'zh-CN',
    speak: async (t) => { spoken.push(t) },
    send: (e) => { sent.push(e) },
    queueRemaining: () => 0,
    media: {
      getLastMusic: () => null,
      play: () => {},
    } as unknown as ContentExecutorDeps['media'],
    getSource: () => source,
    candidateFetcher: async () => ({
      ok: true,
      json: async () => ({
        recordings: opts.candidates.map((c) => ({ title: c.title, 'artist-credit': c.artist ? [{ name: c.artist }] : [] })),
      }),
    }),
    defaultLoop: () => 0,
    defaultVolume: () => 0.5,
    autoLoop: () => false,
    autoSubtitle: () => true,
    clearNewsContext: () => {},
    hasPendingDeals: () => false,
    clearPendingDeals: () => {},
    getLastTtsMedia: () => null,
    playNewsVideo: async () => {},
    getPreferenceKeywords: async () => opts.prefs,
  }
  return { player: new MusicPlayer(deps), spoken, resolve, sent }
}

describe('音乐偏好推荐：无明确内容不自动播默认电台', () => {
  it('「放首歌」+ 有偏好 → 列候选让用户选、口播偏好依据，不调 source.resolve', async () => {
    const { player, spoken, resolve } = makePlayer({
      prefs: ['周杰伦'],
      candidates: [{ title: '稻香', artist: '周杰伦' }, { title: '青花瓷', artist: '周杰伦' }],
    })
    await player.run('play', '放首歌')
    expect(spoken.join('')).toContain('根据你喜欢的周杰伦')
    expect(spoken.join('')).toContain('你想听第几首') // chooseHint
    expect(resolve).not.toHaveBeenCalled() // 绝不播 Groove Salad
    expect(player.hasPendingCandidates()).toBe(true)
  })

  it('「放首歌」+ 偏好也搜不到 → 引导用户说清，不调 source.resolve', async () => {
    const { player, spoken, resolve } = makePlayer({ prefs: ['咖啡'], candidates: [] })
    await player.run('play', '放首歌')
    expect(spoken.join('')).toContain('想听点什么风格') // recommendPrompt
    expect(resolve).not.toHaveBeenCalled()
    expect(player.hasPendingCandidates()).toBe(false)
  })
})
