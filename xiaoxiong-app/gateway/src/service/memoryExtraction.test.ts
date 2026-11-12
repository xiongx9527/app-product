import { describe, it, expect } from 'vitest'
import {
  createMemoryExtractor,
  formatExisting,
  buildHistoryText,
  parseExtractorInput,
  type ExtractedMemory,
} from './memoryExtraction'
import type { MemoryEntry } from './dataService'
import type { LlmConfig } from '../config'

describe('memoryExtraction 纯函数', () => {
  it('formatExisting 空列表返回空串', () => {
    expect(formatExisting([])).toBe('')
  })

  it('formatExisting 按「- key：value」格式化', () => {
    const entries: MemoryEntry[] = [
      { key: '作息', value: '七点起床', createdAt: 0, updatedAt: 0 },
      { key: '口味', value: '不吃辣', createdAt: 1, updatedAt: 1 },
    ]
    expect(formatExisting(entries)).toBe('- 作息：七点起床\n- 口味：不吃辣')
  })

  it('buildHistoryText 过滤空白句并编号', () => {
    expect(buildHistoryText([])).toBe('')
    expect(buildHistoryText(['  ', '', '   '])).toBe('')
    expect(buildHistoryText([' 说点话 ', '', '  第二句 '])).toBe('1. 说点话\n2. 第二句')
  })

  it('parseExtractorInput 容错：空/非法/结构不对都返回空', () => {
    expect(parseExtractorInput(undefined)).toEqual([])
    expect(parseExtractorInput('')).toEqual([])
    expect(parseExtractorInput('not json')).toEqual([])
    expect(parseExtractorInput('{"foo":1}')).toEqual([])
  })

  it('parseExtractorInput 正常解析并过滤残缺条目', () => {
    const input = JSON.stringify({
      entries: [
        { key: '作息', value: '七点起床' },
        { key: '', value: 'x' },
        { key: 'k' },
        { key: ' 口味 ', value: ' 不吃辣 ' },
      ],
    })
    const got: ExtractedMemory[] = parseExtractorInput(input)
    expect(got).toEqual([
      { key: '作息', value: '七点起床' },
      { key: '口味', value: '不吃辣' },
    ])
  })
})

describe('createMemoryExtractor 离线（stub）短路', () => {
  it('stub 模型 extract / consolidate 都返回空，且不会构造模型', () => {
    const makeModel = (() => {
      throw new Error('makeModel 不应被调用')
    }) as unknown as (cfg: LlmConfig, stream?: boolean) => unknown
    const stubCfg: LlmConfig = { provider: 'stub', model: '', apiKey: '', baseUrl: '', params: {} }
    const ex = createMemoryExtractor('zh-CN', stubCfg, makeModel)
    return Promise.all([ex.extract(['今天天气怎么样'], []), ex.consolidate([])]).then(([a, b]) => {
      expect(a).toEqual([])
      expect(b).toEqual([])
    })
  })
})
