import { describe, it, expect } from 'vitest'
import { createDb } from '../db/client'
import { createDataService } from '../service/dataService'

function makeData() {
  const db = createDb(':memory:')
  return createDataService(db)
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

  it('listPage 分页：返回本页条目与总数，越界页返回空', async () => {
    const data = makeData()
    for (let i = 1; i <= 5; i++) {
      await data.saveMemory('dev-1', `k${i}`, `v${i}`)
    }
    const p1 = await data.listMemoriesPage('dev-1', 1, 2)
    expect(p1.total).toBe(5)
    expect(p1.items).toHaveLength(2)
    const p3 = await data.listMemoriesPage('dev-1', 3, 2)
    expect(p3.items).toHaveLength(1)
    const p99 = await data.listMemoriesPage('dev-1', 99, 2)
    expect(p99.items).toHaveLength(0)
    expect(p99.total).toBe(5)
    // 三页拼起来应覆盖全部 5 条且互不重复
    const keys = [
      ...(await data.listMemoriesPage('dev-1', 1, 2)).items,
      ...(await data.listMemoriesPage('dev-1', 2, 2)).items,
      ...(await data.listMemoriesPage('dev-1', 3, 2)).items,
    ].map((m) => m.key)
    expect(new Set(keys).size).toBe(5)
  })

  it('listPage 按设备隔离', async () => {
    const data = makeData()
    await data.saveMemory('dev-A', '音乐', '周杰伦')
    await data.saveMemory('dev-B', '音乐', '陈奕迅')
    const a = await data.listMemoriesPage('dev-A', 1, 10)
    expect(a.total).toBe(1)
    expect(a.items[0].value).toBe('周杰伦')
  })

  it('listPage 关键词 q 对 key/value 模糊检索', async () => {
    const data = makeData()
    await data.saveMemory('dev-1', '喜欢的音乐', '周杰伦')
    await data.saveMemory('dev-1', '作息', '晚上 12 点睡')
    await data.saveMemory('dev-1', '饮食', '爱吃花菜')
    // 命中 key 包含
    const byKey = await data.listMemoriesPage('dev-1', 1, 10, '音乐')
    expect(byKey.total).toBe(1)
    expect(byKey.items[0].key).toBe('喜欢的音乐')
    // 命中 value 包含
    const byVal = await data.listMemoriesPage('dev-1', 1, 10, '花菜')
    expect(byVal.total).toBe(1)
    expect(byVal.items[0].key).toBe('饮食')
    // 不命中返回空
    const none = await data.listMemoriesPage('dev-1', 1, 10, '篮球')
    expect(none.total).toBe(0)
  })

  it('listPage 关键词 q 与设备隔离叠加', async () => {
    const data = makeData()
    await data.saveMemory('dev-A', '音乐', '周杰伦')
    await data.saveMemory('dev-B', '音乐', '陈奕迅')
    const a = await data.listMemoriesPage('dev-A', 1, 10, '音乐')
    expect(a.total).toBe(1)
    expect(a.items[0].value).toBe('周杰伦')
  })
})
