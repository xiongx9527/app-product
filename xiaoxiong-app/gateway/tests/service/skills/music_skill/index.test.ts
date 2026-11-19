import { describe, it, expect, vi } from 'vitest'
import type { SkillContext } from '../../../../src/service/skills/types'
import { musicSkill } from '../../../../src/service/skills/music_skill/index'

function makeCtx(): { ctx: SkillContext; content: { play: ReturnType<typeof vi.fn>; next: ReturnType<typeof vi.fn>; recommend: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> } } {
  const content = {
    play: vi.fn(async () => true),
    next: vi.fn(async () => true),
    recommend: vi.fn(async () => true),
    select: vi.fn(async () => true),
  }
  const ctx: SkillContext = {
    lang: 'zh-CN', timezone: 'Asia/Shanghai', deviceId: 'dev-1',
    data: {} as unknown as SkillContext['data'], memoryStore: undefined, agent: null,
    send: () => {}, speak: async () => {}, queueRemaining: () => 0,
    content,
  }
  return { ctx, content }
}

describe('music skill：意图路由（播什么是 skill，怎么播走 content 回调/能力层）', () => {
  it('点歌意图 → content.play', async () => {
    const { ctx, content } = makeCtx()
    const skill = musicSkill.create(ctx)
    const r = await skill.onDirectCommand?.('播放周杰伦的稻香')
    expect(r?.consumed).toBe(true)
    expect(content.play).toHaveBeenCalledWith('播放周杰伦的稻香')
  })

  it('换一首 → content.next', async () => {
    const { ctx, content } = makeCtx()
    const skill = musicSkill.create(ctx)
    await skill.onDirectCommand?.('换一首')
    expect(content.next).toHaveBeenCalled()
  })

  it('推荐 → content.recommend', async () => {
    const { ctx, content } = makeCtx()
    const skill = musicSkill.create(ctx)
    await skill.onDirectCommand?.('推荐几首歌')
    expect(content.recommend).toHaveBeenCalled()
  })

  it('暂停等非内容指令不处理（归 mediaControl）', async () => {
    const { ctx, content } = makeCtx()
    const skill = musicSkill.create(ctx)
    const r = await skill.onDirectCommand?.('暂停播放')
    expect(r).toBeUndefined()
    expect(content.play).not.toHaveBeenCalled()
  })

  it('无 content 回调时不消费（渐进接入，行为交核心）', async () => {
    const ctx: SkillContext = {
      lang: 'zh-CN', timezone: 'Asia/Shanghai', deviceId: 'dev-1',
      data: {} as unknown as SkillContext['data'], memoryStore: undefined, agent: null,
      send: () => {}, speak: async () => {}, queueRemaining: () => 0,
    }
    const skill = musicSkill.create(ctx)
    const r = await skill.onDirectCommand?.('播放稻香')
    expect(r?.consumed).toBeFalsy()
  })

  it('description 不写死业务规则、不提 play_media 工具', () => {
    expect(musicSkill.description('zh-CN')).toBeTruthy()
    expect(musicSkill.description('zh-CN')).not.toContain('play_media')
  })
})
