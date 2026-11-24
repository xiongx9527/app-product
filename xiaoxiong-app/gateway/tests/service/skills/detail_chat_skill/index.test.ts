import { describe, it, expect, vi } from 'vitest'
import type { DetailContext, ServerEvent } from '../../../../src/protocol'
import type { SkillContext } from '../../../../src/service/skills/types'
import { detailChatSkill } from '../../../../src/service/skills/detail_chat_skill/index'
import { isConfirmYes, isConfirmNo } from '../../../../src/service/skills/confirm'

const detail: DetailContext = {
  kind: 'deals',
  index: 1,
  title: '全友家居 飞鸟沙发',
  fields: [
    { label: '现价', value: '1748元' },
    { label: '商城', value: '京东' },
    { label: '历史价', value: '常购价 ¥2819' },
  ],
}

function makeCtx(overrides: Partial<SkillContext> = {}): {
  ctx: SkillContext
  spoken: string[]
  events: ServerEvent[]
  reply: ReturnType<typeof vi.fn>
} {
  const spoken: string[] = []
  const events: ServerEvent[] = []
  const reply = vi.fn(async (_hint: string, onDelta: (d: string) => void) => {
    onDelta('这款沙发现在')
    onDelta('1748元，京东在售。')
  })
  const ctx: SkillContext = {
    lang: 'zh-CN',
    timezone: 'Asia/Shanghai',
    deviceId: 'dev-1',
    data: {} as SkillContext['data'],
    memoryStore: undefined,
    agent: { reply } as unknown as SkillContext['agent'],
    send: (e) => { events.push(e) },
    speak: async (t) => { spoken.push(t) },
    queueRemaining: () => 0,
    ...overrides,
  }
  return { ctx, spoken, events, reply }
}

describe('通用确认判定 confirm', () => {
  it('肯定口语', () => {
    for (const t of ['好', '好的', '要', '要啊', '嗯', '对', '介绍一下', '讲讲吧', 'OK', '那就介绍']) {
      expect(isConfirmYes(t), t).toBe(true)
    }
  })
  it('否定口语', () => {
    for (const t of ['不', '不用', '不要', '算了', '不介绍', '不用了', 'no']) {
      expect(isConfirmNo(t), t).toBe(true)
      expect(isConfirmYes(t), t).toBe(false)
    }
  })
  it('含糊/问句不算肯定', () => {
    for (const t of ['', '啊?', '再说', '这个多少钱', '好的但是']) {
      expect(isConfirmYes(t), t).toBe(false)
    }
  })
})

describe('detail_chat skill：通用详情反问介绍', () => {
  it('打开详情先反问，不直接介绍', async () => {
    const { ctx, spoken, reply } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain('介绍')
    expect(reply).not.toHaveBeenCalled()
  })

  it('肯定 → LLM 基于详情字段介绍（agent.reply → speak），消费这句', async () => {
    const { ctx, spoken, events, reply } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    const r = await skill.onIntroConfirm?.('好')
    expect(r?.consumed).toBe(true)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0][0]).toContain('详情')
    expect(spoken.at(-1)).toContain('1748元')
    expect(events.some((e) => e.type === 'asr.final')).toBe(true)
  })

  it('否定 → 口播不介绍、不调 LLM，消费这句', async () => {
    const { ctx, spoken, reply } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    const r = await skill.onIntroConfirm?.('不用')
    expect(r?.consumed).toBe(true)
    expect(spoken.at(-1)).toContain('不介绍')
    expect(reply).not.toHaveBeenCalled()
  })

  it('既非肯定也非否定 → 保留待确认、不消费', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    const r = await skill.onIntroConfirm?.('这个多少钱')
    expect(r?.consumed).not.toBe(true)
    expect(spoken).toHaveLength(1)
    // 待确认仍在，下一句「好」仍能介绍
    const r2 = await skill.onIntroConfirm?.('好')
    expect(r2?.consumed).toBe(true)
  })

  it('打开新详情清掉上一条待确认（不重复反问串味）', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    await skill.onDetailOpen?.({ ...detail, title: '另一件' })
    // 反问仍是每次打开各一句
    expect(spoken).toHaveLength(2)
  })

  it('关详情 / 会话结束清状态：之后「好」不再被消费', async () => {
    const { ctx } = makeCtx()
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    await skill.onDetailClose?.()
    expect((await skill.onIntroConfirm?.('好'))?.consumed).not.toBe(true)
    await skill.onDetailOpen?.(detail)
    skill.onSessionReset?.('end')
    expect((await skill.onIntroConfirm?.('好'))?.consumed).not.toBe(true)
  })

  it('英文会话用英文反问', async () => {
    const { ctx, spoken } = makeCtx({ lang: 'en-US' })
    const skill = detailChatSkill.create(ctx)
    await skill.onDetailOpen?.(detail)
    expect(spoken[0]).toMatch(/introduce/i)
  })
})
