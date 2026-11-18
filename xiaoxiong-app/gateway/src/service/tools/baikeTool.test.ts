import { describe, it, expect } from 'vitest'
import { createBaikeTool, BAIKE_TOOL_NAME } from './baikeTool'
import type { BaikeSource } from '../baike'

const stubSource = (entry: { title: string; summary: string } | null): BaikeSource => ({
  name: 'stub',
  fetch: async () => (entry ? { ...entry } : null),
})

describe('createBaikeTool', () => {
  it('工具名固定', () => {
    expect(createBaikeTool('zh-CN').name).toBe(BAIKE_TOOL_NAME)
  })

  it('中文：标题 + 摘要', async () => {
    const tool = createBaikeTool('zh-CN', {
      source: stubSource({ title: '李存勖', summary: '五代后唐开国皇帝，军事才能出众。' }),
    })
    expect(await tool.call({ query: '李存勖' })).toBe('李存勖：五代后唐开国皇帝，军事才能出众。')
  })

  it('无结果：本地化兜底文案', async () => {
    const tool = createBaikeTool('zh-CN', { source: stubSource(null) })
    expect(await tool.call({ query: '不存在xyz' })).toContain('暂时没查到')
  })

  it('英文兜底', async () => {
    const tool = createBaikeTool('en-US', { source: stubSource(null) })
    expect(await tool.call({ query: 'xyz' })).toContain("couldn't find")
  })

  it('空 query 提示用户', async () => {
    const tool = createBaikeTool('zh-CN', { source: stubSource(null) })
    expect(await tool.call({})).toContain('请告诉我想查什么')
  })

  it('长摘要截断到句号边界', async () => {
    const long = '甲'.repeat(280) + '。' + '乙'.repeat(50)
    const tool = createBaikeTool('zh-CN', { source: stubSource({ title: 'X', summary: long }) })
    const out = await tool.call({ query: 'X' }) as string
    expect(out.length).toBeLessThan(320)
    expect(out.endsWith('。')).toBe(true)
    expect(out).not.toContain('乙')
  })

  it('source 抛异常不影响工具：返回兜底', async () => {
    const bad: BaikeSource = { name: 'bad', fetch: async () => { throw new Error('网络错误') } }
    const tool = createBaikeTool('zh-CN', { source: bad })
    expect(await tool.call({ query: 'X' })).toContain('暂时没查到')
  })

  it('snapshotWithText 同时返回结构与文案（直连用）', async () => {
    const tool = createBaikeTool('zh-CN', {
      source: stubSource({ title: '李存勖', summary: '后唐开国皇帝。' }),
    })
    const r = await tool.snapshotWithText('李存勖')
    expect(r.entry?.title).toBe('李存勖')
    expect(r.text).toContain('后唐开国皇帝')
  })

  it('snapshotWithText 的 spoken 是真正被播报的正文（截断后、不含标题前缀）', async () => {
    const long = '甲'.repeat(280) + '。' + '乙'.repeat(50)
    const tool = createBaikeTool('zh-CN', { source: stubSource({ title: 'X', summary: long }) })
    const r = await tool.snapshotWithText('X')
    // text 供口播（含标题前缀），spoken 供字幕（与音频同源，不含前缀、已截断）
    expect(r.text.startsWith('X：')).toBe(true)
    expect(r.spoken).toBe('甲'.repeat(280) + '。')
    expect(r.spoken).not.toContain('乙')
  })

  it('snapshotWithText 无结果时 spoken 为空（不拿兜底文案当正文）', async () => {
    const tool = createBaikeTool('zh-CN', { source: stubSource(null) })
    const r = await tool.snapshotWithText('不存在xyz')
    expect(r.entry).toBeNull()
    expect(r.text).toContain('暂时没查到')
    expect(r.spoken).toBe('')
  })

  it('inputSchema 要求 query 字段', () => {
    const tool = createBaikeTool('zh-CN')
    expect(tool.inputSchema).toBeDefined()
  })
})
