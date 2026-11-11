import { describe, expect, it } from 'vitest'
import { projectsToDetailItems } from './detail'
import type { OpenSourceProject } from './types'

const project: OpenSourceProject = {
  name: 'UIEIP',
  title: '低代码开发平台',
  detail: '一个 Go 单文件，把数据建模 + 表单 + 权限全装进去。',
  language: 'Go',
  os: '跨平台',
  link: 'https://www.oschina.net/p/77729',
  publishedAt: '2026-11-10',
}

describe('projectsToDetailItems（与商品同一套统一字段契约）', () => {
  it('固定槽位只有 index/title/link，其余属性统一进 fields[]，不含来源专属字段', () => {
    const [item] = projectsToDetailItems([project], 'zh-CN')
    expect(item.index).toBe(1)
    expect(item.title).toBe('UIEIP')
    expect(item.link).toBe(project.link)
    const raw = item as unknown as Record<string, unknown>
    // 内部 OpenSourceProject 的字段一律不出现在协议层
    for (const key of ['name', 'detail', 'language', 'os', 'publishedAt']) {
      expect(raw[key]).toBeUndefined()
    }
    expect(item.fields?.map((f) => f.label)).toEqual([
      '定位',
      '语言',
      '系统',
      '简介',
      '收录时间',
    ])
    expect(item.fields?.find((f) => f.label === '语言')?.value).toBe('Go')
  })

  it('与商品详情形状一致：同一个 DetailItem，客户端可共用一个渲染器', () => {
    const [item] = projectsToDetailItems([project], 'zh-CN')
    // 只有统一契约允许的固定槽位
    expect(Object.keys(item).sort()).toEqual(['fields', 'index', 'link', 'title'])
  })

  it('字段缺失容忍：新源没给语言/系统/简介也不崩、不产生空 fields', () => {
    const sparse: OpenSourceProject = {
      name: '只有名字',
      title: '',
      detail: '',
      language: '',
      os: '',
      link: '',
      publishedAt: '',
    }
    const [item] = projectsToDetailItems([sparse], 'zh-CN')
    expect(item.title).toBe('只有名字')
    expect(item.link).toBeUndefined()
    expect(item.fields).toBeUndefined()
  })

  it('按顺序编号（index 从 1 开始）', () => {
    const items = projectsToDetailItems([project, { ...project, name: '第二个' }], 'zh-CN')
    expect(items.map((i) => i.index)).toEqual([1, 2])
  })

  it('label 按会话 lang 本地化（换语言不改结构）', () => {
    const [item] = projectsToDetailItems([project], 'en-US')
    expect(item.fields?.map((f) => f.label)).toEqual([
      'Tagline',
      'Language',
      'Platform',
      'Summary',
      'Added',
    ])
  })
})
