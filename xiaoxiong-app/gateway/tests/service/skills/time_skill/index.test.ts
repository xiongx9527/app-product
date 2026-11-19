import { describe, it, expect } from 'vitest'
import type { SkillContext } from '../../../../src/service/skills/types'
import { timeSkill, _detectTimeCommandKind } from '../../../../src/service/skills/time_skill/index'

function makeCtx(): { ctx: SkillContext; spoken: string[] } {
  const spoken: string[] = []
  const ctx: SkillContext = {
    lang: 'zh-CN',
    timezone: 'Asia/Shanghai',
    deviceId: 'dev-1',
    data: {} as unknown as SkillContext['data'],
    memoryStore: undefined,
    agent: null,
    send: () => {},
    speak: async (t) => { spoken.push(t) },
    queueRemaining: () => 0,
  }
  return { ctx, spoken }
}

describe('time skill：意图识别（原 control/timeControl.ts）', () => {
  it('问时间 → time', () => {
    expect(_detectTimeCommandKind('现在几点')).toBe('time')
    expect(_detectTimeCommandKind('报时')).toBe('time')
  })
  it('问日期 → date', () => {
    expect(_detectTimeCommandKind('今天星期几')).toBe('date')
    expect(_detectTimeCommandKind('今天几号')).toBe('date')
  })
  it('时间+日期都问 → both', () => {
    expect(_detectTimeCommandKind('今天星期几点几点')).toBe('both')
  })
  it('非时间句 → null', () => {
    expect(_detectTimeCommandKind('播放音乐')).toBeNull()
    expect(_detectTimeCommandKind('时间都去哪了')).toBeNull()
  })
})

describe('time skill：onDirectCommand 执行', () => {
  it('时间意图被消费并口播时:分', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = timeSkill.create(ctx)
    const r = await skill.onDirectCommand?.('现在几点')
    expect(r?.consumed).toBe(true)
    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toMatch(/\d{1,2}点\d{1,2}分/)
  })

  it('日期意图口播含 年月日/星期/农历（不依赖 Intl 中文 locale）', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = timeSkill.create(ctx)
    const r = await skill.onDirectCommand?.('今天星期几')
    expect(r?.consumed).toBe(true)
    expect(spoken[0]).toContain('年')
    expect(spoken[0]).toContain('月')
    expect(spoken[0]).toContain('日')
    expect(spoken[0]).toContain('星期')
    expect(spoken[0]).toContain('农历')
    expect(spoken[0]).not.toMatch(/November|January|Monday/) // small-ICU fallback 坑
  })

  it('非时间句不消费，交后续 skill / LLM', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = timeSkill.create(ctx)
    const r = await skill.onDirectCommand?.('随便聊聊')
    expect(r?.consumed).toBeFalsy()
    expect(spoken).toHaveLength(0)
  })
})
