import { describe, it, expect } from 'vitest'
import type { ServerEvent } from '../../../protocol'
import type { SkillContext } from '../types'
import { preferenceSkill } from './index'

function makeCtx(overrides: Partial<SkillContext> = {}): {
  ctx: SkillContext
  saved: Array<{ key: string; value: string }>
  spoken: string[]
  events: ServerEvent[]
} {
  const saved: Array<{ key: string; value: string }> = []
  const spoken: string[] = []
  const events: ServerEvent[] = []
  const ctx: SkillContext = {
    lang: 'zh-CN',
    deviceId: 'dev-1',
    data: {
      saveMemory: async (_d: string, k: string, v: string) => { saved.push({ key: k, value: v }) },
    } as unknown as SkillContext['data'],
    memoryStore: {
      save: async () => {},
      list: async () => [],
      forget: async () => 0,
    },
    agent: null,
    send: (e) => { events.push(e) },
    speak: async (t) => { spoken.push(t) },
    queueRemaining: () => 0,
    ...overrides,
  }
  return { ctx, saved, spoken, events }
}

describe('preference skill：偏好句「问一句再记」', () => {
  it('新偏好句只暂存、不消费（让 LLM 先正常回答）', async () => {
    const { ctx } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    const r = await skill.onFinalize?.('我喜欢打乒乓球')
    expect(r?.consumed).toBe(false)
  })

  it('暂存后 onAgentReply 返回同链追问并置 asked（无停顿主路径）', async () => {
    const { ctx } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    const r = skill.onAgentReply?.('', '')
    expect(r?.appendTts).toContain('记')
    // 第二次不再追问（asked 已 true）
    expect(skill.onAgentReply?.('', '')).toBeUndefined()
  })

  it('肯定「要记下来」→ 落库（分类 + 合并）并口播确认，消费这句', async () => {
    const { ctx, saved, spoken } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    skill.onAgentReply?.('', '')
    const r = await skill.onFinalize?.('要记下来')
    expect(r?.consumed).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].key).toBe('运动偏好')
    expect(saved[0].value).toContain('乒乓球')
    expect(spoken.at(-1)).toContain('记')
  })

  it('回答了反问 + 要记下来的混合句也算肯定（真机场景）', async () => {
    const { ctx, saved } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    skill.onAgentReply?.('', '')
    const r = await skill.onFinalize?.('正手吧，要记下来')
    expect(r?.consumed).toBe(true)
    expect(saved).toHaveLength(1)
  })

  it('否定 → 口播不记、不落库、消费这句', async () => {
    const { ctx, saved, spoken } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    skill.onAgentReply?.('', '')
    const r = await skill.onFinalize?.('不记')
    expect(r?.consumed).toBe(true)
    expect(saved).toHaveLength(0)
    expect(spoken.at(-1)).toContain('不记')
  })

  it('既非肯定也非否定 → 保留 pending、不消费，让 LLM 正常回答', async () => {
    const { ctx } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    skill.onAgentReply?.('', '')
    const r = await skill.onFinalize?.('今天天气怎么样')
    expect(r?.consumed).toBe(false)
    // pending 仍在：随后的肯定还能记
    const r2 = await skill.onFinalize?.('好，记下来')
    expect(r2?.consumed).toBe(true)
  })

  it('onAfterSpeak 兜底追问（同链没走到时），asked 后 no-op', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    // 没调 onAgentReply，模拟同链追问没走到
    await skill.onAfterSpeak?.('回答正文')
    expect(spoken.some((t) => t.includes('记'))).toBe(true)
    const before = spoken.length
    await skill.onAfterSpeak?.('回答正文')
    expect(spoken.length).toBe(before) // asked 已 true，不再追问
  })

  it('onSessionReset 清空 pending，不跨会话串味', async () => {
    const { ctx, saved } = makeCtx()
    const skill = preferenceSkill.create(ctx)
    await skill.onFinalize?.('我喜欢打乒乓球')
    skill.onAgentReply?.('', '')
    skill.onSessionReset?.('cancel')
    // reset 后这句肯定不应再记（没有 pending 上下文）
    const r = await skill.onFinalize?.('要记下来')
    expect(r?.consumed).toBe(false)
    expect(saved).toHaveLength(0)
  })

  it('无 deviceId 不暂存、不落库', async () => {
    const { ctx, saved } = makeCtx({ deviceId: null })
    const skill = preferenceSkill.create(ctx)
    const r = await skill.onFinalize?.('我喜欢打乒乓球')
    expect(r?.consumed).toBe(false)
    expect(skill.onAgentReply?.('', '')).toBeUndefined()
    expect(saved).toHaveLength(0)
  })

  it('纯代码钩子型：name 可读、description 不向 LLM 注入业务规则', () => {
    expect(preferenceSkill.name).toBeTruthy()
    expect(preferenceSkill.description('zh-CN')).toBe('')
  })
})
