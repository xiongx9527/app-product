import { describe, it, expect } from 'vitest'
import { createCurrentTimeTool, createToolkit, TIME_TOOL_NAME, formatNow } from './index'

describe('currentTimeTool', () => {
  it('工具名固定、描述随语言本地化', () => {
    const zh = createCurrentTimeTool('zh-CN')
    expect(zh.name).toBe(TIME_TOOL_NAME)
    expect(zh.description).toContain('时间')
    const en = createCurrentTimeTool('en-US')
    expect(en.description.toLowerCase()).toContain('time')
    const ja = createCurrentTimeTool('ja-JP')
    expect(ja.description).toContain('時')
  })

  it('call 返回当前时间，含四位年份与时区偏移', () => {
    const result = createCurrentTimeTool('zh-CN').call?.()
    expect(typeof result).toBe('string')
    expect(result).toMatch(/\d{4}/)
    // 默认东八区：结果里带 UTC+08:00 之类偏移
    expect(result).toMatch(/UTC\+0?8:?00|GMT\+0?8/i)
  })

  it('timezone 可配置，缺省东八区', () => {
    expect(formatNow('zh-CN', 'Asia/Shanghai')).toMatch(/UTC\+0?8:?00|GMT\+0?8/i)
    expect(formatNow('zh-CN')).toMatch(/UTC\+0?8:?00|GMT\+0?8/i)
  })

  it('createToolkit 把时间工具登记进去（并带入时区）', () => {
    const schemas = createToolkit('zh-CN', 'Asia/Shanghai').getJSONSchemas()
    expect(schemas.some((s) => s.function.name === TIME_TOOL_NAME)).toBe(true)
  })
})
