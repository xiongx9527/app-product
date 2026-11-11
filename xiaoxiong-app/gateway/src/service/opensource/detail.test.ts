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
      '开发语言',
      '开源协议',
      '系统',
      '收录时间',
      '简介',
    ])
    expect(item.fields?.find((f) => f.label === '开发语言')?.value).toBe('Go')
  })

  it('与商品详情形状一致：同一个 DetailItem，客户端可共用一个渲染器', () => {
    const [item] = projectsToDetailItems([project], 'zh-CN')
    // 只有统一契约允许的固定槽位
    // undefined 值的槽位序列化后不下发，不算实际字段
    const keys = Object.entries(item).filter(([, v]) => v !== undefined).map(([k]) => k)
    expect(keys.sort()).toEqual(['fields', 'index', 'link', 'title'])
  })

  it('字段缺失容忍：源没给语言/协议时留占位行，不编造具体值', () => {
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
    // 用户要看的两行仍在，但值如实为「暂无」
    expect(item.fields?.map((f) => f.label)).toEqual(['开发语言', '开源协议'])
    expect(item.fields?.every((f) => f.value === '暂无')).toBe(true)
  })

  it('按顺序编号（index 从 1 开始）', () => {
    const items = projectsToDetailItems([project, { ...project, name: '第二个' }], 'zh-CN')
    expect(items.map((i) => i.index)).toEqual([1, 2])
  })

  it('来源按 lang 本地化并放在最前，协议有值就显示', () => {
    const withSource: OpenSourceProject = {
      ...project,
      sourceKey: 'oschina',
      image: 'https://oscimg.oschina.net/logo.png',
      license: 'Apache-2.0',
    }
    const [zh] = projectsToDetailItems([withSource], 'zh-CN')
    expect(zh.fields?.[0]).toEqual({ label: '来源', value: '开源中国' })
    expect(zh.fields?.find((f) => f.label === '开源协议')?.value).toBe('Apache-2.0')
    // oscimg 防盗链，浏览器直连 403，所以不下发 image（列表不留空方块）
    expect(zh.image).toBeUndefined()
    const [en] = projectsToDetailItems([withSource], 'en-US')
    expect(en.fields?.[0]).toEqual({ label: 'Source', value: 'OSCHINA' })
  })

  it('占位文案也按 lang 本地化', () => {
    const [item] = projectsToDetailItems([{ ...project, language: '', license: undefined }], 'en-US')
    expect(item.fields?.filter((f) => f.value === 'N/A').map((f) => f.label)).toEqual([
      'Language', 'License',
    ])
  })

  it('label 按会话 lang 本地化（换语言不改结构）', () => {
    const [item] = projectsToDetailItems([project], 'en-US')
    expect(item.fields?.map((f) => f.label)).toEqual([
      'Tagline',
      'Language',
      'License',
      'Platform',
      'Added',
      'Summary',
    ])
  })
})
