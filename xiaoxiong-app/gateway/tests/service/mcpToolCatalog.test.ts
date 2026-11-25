import { describe, it, expect } from 'vitest'
import { extractParams } from '../../src/service/mcpToolCatalog'

describe('extractParams：MCP 工具参数 schema 解析（多种形态兼容）', () => {
  it('标准 JSON Schema：取 type + description + required', () => {
    const params = extractParams({
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题' },
        datasourceId: { type: 'integer' },
      },
      required: ['question'],
    })
    expect(params).toEqual([
      { name: 'question', type: 'string', description: '要问的问题', required: true },
      { name: 'datasourceId', type: 'integer', description: '', required: false },
    ])
  })

  it('nullable（anyOf）：取非 null 分支的类型', () => {
    const params = extractParams({
      type: 'object',
      properties: {
        token: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    })
    expect(params[0].type).toBe('string')
  })

  it('FastMCP 无类型注解回退形态：类型 any、说明用 title 兜底', () => {
    const params = extractParams({
      type: 'object',
      properties: {
        question: { default: null, title: 'Question' },
        datasourceId: { default: null, title: 'Datasourceid' },
      },
    })
    expect(params).toEqual([
      { name: 'question', type: 'any', description: 'Question', required: false },
      { name: 'datasourceId', type: 'any', description: 'Datasourceid', required: false },
    ])
  })

  it('description 优先于 title', () => {
    const params = extractParams({
      properties: { q: { type: 'string', description: '真实说明', title: 'Title' } },
    })
    expect(params[0].description).toBe('真实说明')
  })

  it('无 properties：返回空数组', () => {
    expect(extractParams({ type: 'object', properties: {} })).toEqual([])
    expect(extractParams(null)).toEqual([])
  })

  it('object/boolean 等复杂类型同样保留 type', () => {
    const params = extractParams({
      properties: {
        datasourceId: { type: 'object' },
        stream: { type: 'boolean' },
      },
    })
    expect(params.map((p) => p.type)).toEqual(['object', 'boolean'])
  })
})
