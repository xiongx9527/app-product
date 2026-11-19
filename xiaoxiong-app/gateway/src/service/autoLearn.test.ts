import { describe, it, expect } from 'vitest'
import { createAutoLearnEngine, normalizePronunciation, longestSharedSubstring, extractAnchoredWords, PRON_NORMALIZERS, type AutoLearnRule, type AutoLearnContext } from './autoLearn'

describe('autoLearn 通用自动学习引擎', () => {
  it('规则链：先注册的规则命中即止，后注册的不执行', async () => {
    const engine = createAutoLearnEngine()
    const calls: string[] = []
    const r1: AutoLearnRule = { name: 'r1', handle: async () => { calls.push('r1'); return true } }
    const r2: AutoLearnRule = { name: 'r2', handle: async () => { calls.push('r2'); return true } }
    engine.register(r1)
    engine.register(r2)
    expect(await engine.learn('a', 'b')).toBe(true)
    expect(calls).toEqual(['r1'])
  })

  it('规则可扩展：新增规则无需改调用方', async () => {
    const engine = createAutoLearnEngine()
    expect(await engine.learn('x', 'y')).toBe(false) // 无规则
    engine.register({ name: 'custom', handle: async (f, t) => f === 'x' && t === 'y' })
    expect(await engine.learn('x', 'y')).toBe(true)
  })

  it('单条规则抛错不影响后续规则', async () => {
    const engine = createAutoLearnEngine()
    engine.register({ name: 'bad', handle: async () => { throw new Error('boom') } })
    engine.register({ name: 'good', handle: async () => true })
    expect(await engine.learn('a', 'b')).toBe(true)
  })

  it('发音归一化表可扩展：平翘舌 zh/z ch/c sh/s 归一', () => {
    expect(normalizePronunciation('shi si zhi chi')).toBe('si si zi ci')
    expect(PRON_NORMALIZERS.some((r) => r.name.includes('平翘舌'))).toBe(true)
  })

  it('extractAnchoredWords：锚点提取规范词，不带"背/正在"噪声', () => {
    expect(extractAnchoredWords('找到曹植的《洛神赋》，正在为你朗读。')).toContain('洛神赋')
    expect(extractAnchoredWords('正在为你播放：夜的钢琴曲。')).toContain('夜的钢琴曲')
    expect(extractAnchoredWords('洛神赋：曹植创作的辞赋。')).toContain('洛神赋')
    expect(extractAnchoredWords('好的，我来帮你查一下。')).toEqual([])
  })

  it('learnFromAnchors：李存旭(识别) + LLM回复里的李存勖 → 交给规则', async () => {
    const engine = createAutoLearnEngine()
    const seen: Array<[string, string]> = []
    engine.register({ name: 'rec', handle: async (f, t, ctx) => {
      if (ctx.anchored) seen.push([f, t]); return false
    } })
    await engine.learnFromAnchors('李存旭的百科', '曹植《李存勖》的故事', { source: 'llm' })
    expect(seen).toContainEqual(['李存旭', '李存勖'])
  })

  it('longestSharedSubstring：数据源纠错公共子串判断', () => {
    expect(longestSharedSubstring('贝洛神父', '洛神赋')).toBe(2) // 洛神
    expect(longestSharedSubstring('若神父', '洛神赋')).toBe(1)   // 仅"神"1字相同，source-correction 规则会拒绝（由 homophone 规则处理）
    expect(longestSharedSubstring('苹果', '香蕉')).toBe(0)       // 无关词
    expect(longestSharedSubstring('滕王格世', '滕王阁序')).toBe(2) // 滕王
  })

  it('命中时 logger 收到来源 source，可区分 tool/llm/直接', async () => {
    const logs: Array<{ from: string; to: string; source: string; rule: string }> = []
    const engine = createAutoLearnEngine((from, to, ctx: AutoLearnContext, rule) =>
      logs.push({ from, to, source: ctx.source ?? '?', rule }))
    engine.register({ name: 'homophone-correction', handle: async () => true })
    await engine.learn('李存旭', '李存勖', { source: 'tool' })
    await engine.learn('李存旭', '李存勖', { source: 'llm' })
    await engine.learn('李存旭', '李存勖', { source: 'direct' })
    expect(logs.map((l) => l.source)).toEqual(['tool', 'llm', 'direct'])
    expect(logs[0].rule).toBe('homophone-correction')
  })

  it('learnFromTexts 从两段文本提取中文词交给规则', async () => {
    const engine = createAutoLearnEngine()
    const seen: Array<[string, string]> = []
    engine.register({ name: 'rec', handle: async (f, t) => { seen.push([f, t]); return false } })
    await engine.learnFromTexts('背若神父', '背洛神赋', { source: 'llm' })
    expect(seen).toContainEqual(['若神父', '洛神赋'])
  })
})
