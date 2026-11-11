import { describe, it, expect, vi } from 'vitest'
import { createOpenSourceTool, OPENSOURCE_TOOL_NAME } from '../tools/opensourceTool'
import { createToolkit } from '../tools'
import { filterProjects, formatProjects, normalizeKeyword, type OpenSourceFetcher } from './types'
import { createOschinaSource, parseOschina } from './oschina'
import { messages } from '../../i18n'

/** 固定 JSON 片段，覆盖项目名/定位/简介/语言/系统/时间/链接的解析。 */
const SAMPLE_JSON = JSON.stringify({
  success: true,
  code: 200,
  result: {
    records: [
      {
        id: 77729,
        ident: 'uieip',
        name: 'UIEIP',
        title: '低代码开发平台',
        detail: '一个  Go  单文件，把「数据建模 + 表单 + 权限」全装进去。',
        programmingLanguage: 'Go',
        operatingSystem: '跨平台',
        createTime: '2026-11-10 18:37:51',
      },
      {
        id: 77727,
        ident: null,
        name: 'vmr',
        title: 'Rust 编写的超级 SDK 版本管理器',
        detail: 'vmr 是 Rust 实现的跨平台 SDK 版本管理工具。',
        programmingLanguage: null,
        operatingSystem: null,
        createTime: '2026-11-10 10:58:01',
      },
      {
        id: 77726,
        ident: 'dbmind',
        name: 'DBmind',
        title: '数据库自治运维平台',
        detail: 'openGauss 的自治运维与调优组件。',
        programmingLanguage: 'Python',
        createTime: '2026-11-09 09:00:00',
      },
    ],
    total: 10000,
    size: 20,
    current: 1,
    pages: 500,
  },
})

describe('parseOschina', () => {
  it('解析出项目名/定位/简介/语言/系统/时间/链接，并折叠空白', () => {
    const list = parseOschina(SAMPLE_JSON)
    expect(list).toHaveLength(3)
    const [a, b] = list
    expect(a.name).toBe('UIEIP')
    expect(a.title).toBe('低代码开发平台')
    expect(a.detail).toBe('一个 Go 单文件，把「数据建模 + 表单 + 权限」全装进去。')
    expect(a.language).toBe('Go')
    expect(a.os).toBe('跨平台')
    expect(a.publishedAt).toBe('2026-11-10')
    expect(a.link).toBe('https://www.oschina.net/p/uieip')

    // ident 为 null 时回退 id，语言/系统缺失时留空，不编造
    expect(b.name).toBe('vmr')
    expect(b.link).toBe('https://www.oschina.net/p/77727')
    expect(b.language).toBe('')
    expect(b.os).toBe('')
  })

  it('空壳条目（无 name 无 title）被跳过', () => {
    const list = parseOschina(JSON.stringify({ result: { records: [{ id: 1 }] } }))
    expect(list).toHaveLength(0)
  })

  it('result 缺失/结构异常时返回空数组，不抛错', () => {
    expect(parseOschina('{}')).toHaveLength(0)
    expect(parseOschina('{"result":{}}')).toHaveLength(0)
  })
})

describe('normalizeKeyword（触发口径统一带「开源」修饰）', () => {
  it('剥离「开源」/open source，保留核心品类词', () => {
    expect(normalizeKeyword('开源数据库')).toBe('数据库')
    expect(normalizeKeyword('开源 AI 编辑器')).toBe('ai 编辑器')
    expect(normalizeKeyword('open source database')).toBe('database')
    expect(normalizeKeyword('Open-Source 大数据')).toBe('大数据')
  })

  it('只剩泛义名词时视为「不限品类」，返回空串', () => {
    expect(normalizeKeyword('开源项目')).toBe('')
    expect(normalizeKeyword('开源工具')).toBe('')
    expect(normalizeKeyword('开源软件')).toBe('')
    expect(normalizeKeyword('open source projects')).toBe('')
    expect(normalizeKeyword('')).toBe('')
  })

  it('不带修饰的普通关键词原样小写', () => {
    expect(normalizeKeyword('数据库')).toBe('数据库')
  })
})

describe('filterProjects', () => {
  const list = parseOschina(SAMPLE_JSON)

  it('「开源数据库」也能命中「数据库」条目（归一化生效）', () => {
    expect(filterProjects(list, '开源数据库').map((p) => p.name)).toEqual(['DBmind'])
  })

  it('「开源项目」不限品类，返回最新 N 条', () => {
    expect(filterProjects(list, '开源项目', 2)).toHaveLength(2)
  })

  it('关键词按项目名/定位/简介/语言过滤', () => {
    expect(filterProjects(list, 'Rust').map((p) => p.name)).toEqual(['vmr'])
    expect(filterProjects(list, 'Go').map((p) => p.name)).toEqual(['UIEIP'])
    expect(filterProjects(list, '数据库').map((p) => p.name)).toEqual(['DBmind'])
  })

  it('limit 收敛到 1–5 并截断，缺省 4', () => {
    expect(filterProjects(list, undefined, 1)).toHaveLength(1)
    expect(filterProjects(list, undefined, 99)).toHaveLength(3)
    expect(filterProjects(list, undefined, 0)).toHaveLength(1)
    // 缺省最多 4 条；样本只有 3 条，故返回 3，不会超过 4
    expect(filterProjects(list)).toHaveLength(3)
  })

  it('空结果返回空数组', () => {
    expect(filterProjects(list, '不存在的东西')).toHaveLength(0)
  })
})

describe('formatProjects', () => {
  const list = parseOschina(SAMPLE_JSON)

  it('中文带条数、项目名、定位、语言、简介与提示语', () => {
    const text = formatProjects('zh-CN', list)
    expect(text).toContain('查到 3 个开源工具/软件')
    expect(text).toContain('UIEIP')
    expect(text).toContain('低代码开发平台')
    expect(text).toContain('用 Go 开发')
    expect(text).toContain('详情以项目页为准')
  })

  it('逐条带 1、2、3、4 编号，方便用户说编号选择', () => {
    const four = [
      ...list,
      { ...list[0], name: '第四个项目', title: '示例', detail: '', link: 'https://www.oschina.net/p/4' },
    ]
    const text = formatProjects('zh-CN', four)
    expect(text).toContain('1、UIEIP')
    expect(text).toContain('2、vmr')
    expect(text).toContain('3、DBmind')
    expect(text).toContain('4、第四个项目')
    expect(text).toContain('说编号就行')
  })

  it('英文用 1. 2. 3. 编号', () => {
    const text = formatProjects('en-US', list)
    expect(text).toContain('1. UIEIP')
    expect(text).toContain('2. vmr')
    expect(text).toContain('Say the number to pick one')
  })

  it('长简介被截断（省略号），不是编造', () => {
    const long = [{ ...list[0], detail: 'x'.repeat(120) }]
    const text = formatProjects('zh-CN', long)
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(120))
  })

  it('空结果返回「没找到」类文案', () => {
    expect(formatProjects('zh-CN', [])).toContain('暂时没有查到开源工具/软件')
    expect(formatProjects('zh-CN', [], '编辑器')).toContain('没找到与「编辑器」相关的开源工具/软件')
  })

  it('英文本地化', () => {
    const text = formatProjects('en-US', list)
    expect(text).toContain('Found 3 open-source tools')
    expect(text).toContain('check the project page for more')
  })
})

describe('createOpenSourceTool 抓取与降级', () => {
  const source = createOschinaSource()
  const page1 = source.pageUrl(1)
  const page2 = source.pageUrl(2)

  function fetcherFor(map: Record<string, { ok: boolean; status?: number; body: string }>): OpenSourceFetcher {
    return async (url: string) => {
      const hit = map[url]
      return {
        ok: hit?.ok ?? false,
        status: hit?.status ?? 404,
        text: async () => hit?.body ?? '',
      }
    }
  }

  it('无关键词只抓第一页，返回格式化文本', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({})
    expect(out).toContain('查到 3 个开源工具/软件')
  })

  it('结构化结果回调：与口播同一份列表、同一顺序，编号从 1 起', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const cards: Array<Array<{ index: number; title: string; fields?: Array<{ label: string; value: string }> }>> = []
    const tool = createOpenSourceTool('zh-CN', {
      source,
      fetcher: f,
      onResults: (items) => cards.push(items),
    })
    const out = await tool.call?.({})
    expect(cards).toHaveLength(1)
    const items = cards[0]
    // 与播报顺序一致：第 1 条就是口播里的「1、UIEIP」
    expect(out).toContain('1、UIEIP')
    expect(items.map((i) => i.index)).toEqual([1, 2, 3])
    expect(items[0].title).toBe('UIEIP')
    // 详情字段走统一 label+value，客户端不认识具体字段名
    expect(items[0].fields?.map((x) => x.label)).toEqual([
      '来源', '定位', '开发语言', '开源协议', '系统', '收录时间', '简介',
    ])
    // 当前源不给语言/协议，两行如实显示占位而不是编造
    expect(items[0].fields?.find((x) => x.label === '开发语言')?.value).toBe('Go')
    expect(items[0].fields?.find((x) => x.label === '开源协议')?.value).toBe('暂无')
    expect(items[0].fields?.find((x) => x.label === '开发语言')?.value).toBe('Go')
    expect(items[0].fields?.[0]).toEqual({ label: '来源', value: '开源中国' })
  })

  it('没有结果时不下发空卡片', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const cards: unknown[] = []
    const tool = createOpenSourceTool('zh-CN', {
      source,
      fetcher: f,
      onResults: (items) => cards.push(items),
    })
    await tool.call?.({ keyword: '不存在的品类xyz' })
    expect(cards).toHaveLength(0)
  })

  it('泛推荐结合长期记忆：偏好 Python 时 Python 项目排到第 1 条', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const cards: Array<Array<{ title: string }>> = []
    const tool = createOpenSourceTool('zh-CN', {
      source,
      fetcher: f,
      getPreferenceKeywords: async () => ['Python'],
      onResults: (items) => cards.push(items),
    })
    const out = await tool.call?.({})
    // 口播与卡片同一份顺序，用户说「第一个」拿到的是同一件
    expect(out).toContain('1、DBmind')
    expect(cards[0][0].title).toBe('DBmind')
  })

  it('用户指定了品类就不按记忆重排（记忆不能盖过明确需求）', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const tool = createOpenSourceTool('zh-CN', {
      source,
      fetcher: f,
      getPreferenceKeywords: async () => ['Python'],
    })
    const out = await tool.call?.({ keyword: 'Go' })
    expect(out).toContain('UIEIP')
    expect(out).not.toContain('DBmind')
  })

  it('长期记忆读取失败不影响推荐：退回取最新的普通结果', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const tool = createOpenSourceTool('zh-CN', {
      source,
      fetcher: f,
      getPreferenceKeywords: async () => {
        throw new Error('db down')
      },
    })
    const out = await tool.call?.({})
    expect(out).toContain('1、UIEIP')
  })

  it('有关键词并行抓多页并合并去重', async () => {
    const f = fetcherFor({
      [page1]: { ok: true, body: SAMPLE_JSON },
      [page2]: { ok: true, body: SAMPLE_JSON },
    })
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f, keywordPages: 3 })
    const out = await tool.call?.({ keyword: 'Go' })
    // 两页内容相同，去重后仍只有 1 条命中 Go
    expect(out).toContain('查到 1 个')
    expect(out).toContain('UIEIP')
  })

  it('单页 HTTP 非 200 降级（不抛错）', async () => {
    const f = fetcherFor({ [page1]: { ok: false, status: 503, body: '' } })
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({})
    expect(out).toContain('暂时查不到开源工具/软件信息')
  })

  it('全部抓取失败返回「暂时查不到」', async () => {
    const f = vi.fn(fetcherFor({}))
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f, keywordPages: 2 })
    const out = await tool.call?.({ keyword: 'AI' })
    expect(out).toContain('暂时查不到开源工具/软件信息')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('关键词无匹配但抓取成功 → 返回「没找到」而非「暂时查不到」', async () => {
    const f = fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } })
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({ keyword: '量子计算机' })
    expect(out).toContain('没找到与「量子计算机」相关的开源工具/软件')
  })

  it('TTL 内第二次调用复用 Promise，不再触发 fetcher', async () => {
    const f = vi.fn(fetcherFor({ [page1]: { ok: true, body: SAMPLE_JSON } }))
    const tool = createOpenSourceTool('zh-CN', { source, fetcher: f, cacheTtlMs: 60000 })
    await tool.call?.({})
    await tool.call?.({})
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('工具名固定且不被本地化', () => {
    expect(OPENSOURCE_TOOL_NAME).toBe('query_opensource')
    const en = createOpenSourceTool('en-US', { source, fetcher: fetcherFor({}) })
    expect(en.name).toBe('query_opensource')
    expect(en.description.toLowerCase()).toContain('open-source')
  })

  it('触发口径统一为「开源」词族 + 求推荐，中文描述列全', () => {
    const zh = createOpenSourceTool('zh-CN', { source, fetcher: fetcherFor({}) }).description
    for (const w of ['开源项目', '开源工具', '开源数据库', '开源XXX', '有什么好的数据库', '推荐个 AI 工具']) {
      expect(zh).toContain(w)
    }
    // 明确要求纯知识问答不调用，避免误触发
    expect(zh).toContain('纯知识问答')
  })

  it('英文描述同样覆盖 open-source 词族', () => {
    const en = createOpenSourceTool('en-US', { source, fetcher: fetcherFor({}) }).description
    for (const w of ['open-source projects', 'open-source databases', 'any good databases']) {
      expect(en.toLowerCase()).toContain(w)
    }
  })
})

describe('系统提示引导触发（zh/en 都要有）', () => {
  it('中文 systemPrompt 引导用 query_opensource 回答开源词族', () => {
    const p = messages('zh-CN').systemPrompt
    expect(p).toContain('query_opensource')
    expect(p).toContain('开源数据库')
    expect(p).toContain('有什么好的数据库')
  })

  it('英文 systemPrompt 同样引导', () => {
    const p = messages('en').systemPrompt
    expect(p).toContain('query_opensource')
    expect(p.toLowerCase()).toContain('open-source databases')
  })
})

describe('createToolkit 登记 query_opensource', () => {
  it('工具集包含 query_opensource', () => {
    const schemas = createToolkit('zh-CN').getJSONSchemas()
    expect(schemas.some((s) => s.function.name === OPENSOURCE_TOOL_NAME)).toBe(true)
  })
})
