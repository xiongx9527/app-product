import { describe, expect, it } from 'vitest'
import { REPORT_BLOCK_TYPES, isKnownReportBlockType } from '../../../src/features/report/blockTypes'

/**
 * 报表块类型的纯数据真相源测试。
 * registry.ts 因 import .vue 组件无法在 node 环境加载，这里只锁「支持哪些 type / 未知如何兜底」，
 * 组件映射的正确性交给 vue-tsc 与页面挂载验证。
 */
describe('report block types', () => {
  it('当前支持 chart + table + image 三类块，顺序稳定（chart 在前）', () => {
    expect(REPORT_BLOCK_TYPES).toEqual(['chart', 'table', 'image'])
  })

  it('已登记类型命中；未知 / 脏 / 空 type 一律中性跳过', () => {
    expect(isKnownReportBlockType('chart')).toBe(true)
    expect(isKnownReportBlockType('table')).toBe(true)
    expect(isKnownReportBlockType('image')).toBe(true)
    for (const bad of ['text', 'kv', 'webview', '', 'TABLE', 'table ']) {
      expect(isKnownReportBlockType(bad)).toBe(false)
    }
  })
})
