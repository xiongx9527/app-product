import { describe, it, expect } from 'vitest'
import { createDb } from '../db/client'
import { createDataService } from '../service/dataService'

function makeData() {
  const db = createDb(':memory:')
  return createDataService(db, 'pub', 'priv')
}

describe('memoryMapper：去重覆盖、列表、遗忘', () => {
  it('同一设备同一 key 重复写会覆盖而非新增', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', '作息', '晚上 12 点睡')
    await data.saveMemory('dev-1', '作息', '晚上 11 点睡')
    const list = await data.getMemories('dev-1')
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('作息')
    expect(list[0].value).toBe('晚上 11 点睡')
  })

  it('key 首尾/中间空白会被归一化，避免同义分两条', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', '  作息 ', '晚上 12 点睡')
    await data.saveMemory('dev-1', '作息', '晚上 11 点睡')
    const list = await data.getMemories('dev-1')
    expect(list).toHaveLength(1)
    expect(list[0].value).toBe('晚上 11 点睡')
  })

  it('不同设备互相隔离', async () => {
    const data = makeData()
    await data.saveMemory('dev-A', '音乐', '周杰伦')
    await data.saveMemory('dev-B', '音乐', '陈奕迅')
    expect(await data.getMemories('dev-A')).toHaveLength(1)
    expect(await data.getMemories('dev-B')).toHaveLength(1)
    expect((await data.getMemories('dev-A'))[0].value).toBe('周杰伦')
  })

  it('列表按最近更新倒序', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', 'a', '一')
    await data.saveMemory('dev-1', 'b', '二')
    await data.saveMemory('dev-1', 'a', '一更新')
    const list = await data.getMemories('dev-1')
    expect(list.map((m) => m.key)).toEqual(['a', 'b'])
  })

  it('forget 按话题/内容模糊匹配删除；空串清空全部', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', '作息', '晚上 12 点睡')
    await data.saveMemory('dev-1', '喜欢的音乐', '周杰伦')
    // 按 key 包含匹配
    expect(await data.forgetMemory('dev-1', '音乐')).toBe(1)
    // 按 value 包含匹配
    expect(await data.forgetMemory('dev-1', '12 点')).toBe(1)
    expect(await data.getMemories('dev-1')).toHaveLength(0)
    await data.saveMemory('dev-1', 'x', 'y')
    expect(await data.forgetMemory('dev-1', '')).toBe(1)
    expect(await data.getMemories('dev-1')).toHaveLength(0)
  })

  it('forget 未命中返回 0', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', '作息', '晚 12 点')
    expect(await data.forgetMemory('dev-1', '不存在')).toBe(0)
  })
})
