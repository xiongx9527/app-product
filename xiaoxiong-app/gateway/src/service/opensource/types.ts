import type { DetailItem, Lang } from '../../protocol'

/** 单个开源工具/软件条目：只取数据源真实返回的字段，不编造没有返回的字段。 */
export interface OpenSourceProject {
  /** 项目名，如 UIEIP。 */
  name: string
  /** 一句话定位/副标题，如「低代码开发平台」。 */
  title: string
  /** 简介（已做空白归一化）。 */
  detail: string
  /** 编程语言（数据源没给则为空）。 */
  language: string
  /** 操作系统（数据源没给则为空）。 */
  os: string
  /** 详情页链接。 */
  link: string
  /** 收录/更新时间。 */
  publishedAt: string
  /** 开源协议 / 许可证（数据源有给才填，绝不编造）。 */
  license?: string
  /** 项目图标（数据源可选提供）。 */
  image?: string
  /** 数据来源标识（如 oschina）：网关按 lang 查表得到展示名，客户端不认识这个 key。 */
  sourceKey?: string
}

/**
 * 开源工具/软件数据源契约。oschina 只是其中一个实现；
 * 后续接其它源（如 GitHub/Gitee 趋势榜）时，只需新增一个实现，
 * 工具与播报层（tools/opensourceTool）无需改动。
 */
export interface OpenSourceSource {
  /** 数据源标识，仅用于日志/调试，不向用户暴露。 */
  name: string
  /** 列表接口地址（换源只改这里/配置）。 */
  baseUrl: string
  /** 按页码生成要抓取的页面 URL；page<=1 返回第一页。 */
  pageUrl(page: number): string
  /** 解析单页响应文本为条目列表（失败抛错，由上层降级）。 */
  parse(raw: string): OpenSourceProject[]
}

/** 抓取器：测试可注入桩，避免真实联网。 */
export type OpenSourceFetcher = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** 创建工具时的可选项（数据源可插拔；缓存/分页/抓取器为通用配置）。 */
export interface OpenSourceOptions {
  /** 数据源，由外部（组合根）注入，工具本身不绑定任何具体站点。 */
  source: OpenSourceSource
  /** 列表缓存时间（毫秒）。缺省读 OPENSOURCE_CACHE_TTL_MS 或 60000。 */
  cacheTtlMs?: number
  /** 关键词查询最多抓几页。缺省读 OPENSOURCE_KEYWORD_PAGES 或 3。 */
  keywordPages?: number
  /** 注入抓取器（默认全局 fetch）。 */
  fetcher?: OpenSourceFetcher
  /** 结构化结果回调：拿到筛选后的条目时调用，由组合根转成 media.detail 下发给客户端。 */
  onResults?: (items: DetailItem[]) => void
  /** 读取长期记忆偏好关键词（无记忆/读取失败时返回空）：泛推荐时据此排序。
   *  工具层不碰 DataService，由组合根包好注入，离线测试可直接不传。 */
  getPreferenceKeywords?: () => Promise<string[]>
}

/** 把若干条目格式化成本地化纯文本，交给大模型逐条带编号播报，方便用户说编号选择。 */
export function formatProjects(
  lang: Lang | string,
  projects: OpenSourceProject[],
  keyword?: string
): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const en = prefix === 'en'
  if (!projects.length) {
    return keyword
      ? en
        ? `No open-source tools found for "${keyword}".`
        : `没找到与「${keyword}」相关的开源工具/软件。`
      : en
        ? 'No open-source tools found right now.'
        : '暂时没有查到开源工具/软件。'
  }
  const lines = projects.map((p, i) => {
    // 显式编号，方便用户下一句说「第2个」来选；中文用顿号、英文用点号。
    const parts = [en ? `${i + 1}. ${p.name}` : `${i + 1}、${p.name}`]
    if (p.title) parts.push(p.title)
    if (p.language) parts.push(en ? `in ${p.language}` : `用 ${p.language} 开发`)
    // 简介截断，避免语音播报过长；截断属于省略而非编造。
    const detail = p.detail.length > 50 ? `${p.detail.slice(0, 50)}…` : p.detail
    if (detail) parts.push(detail)
    if (p.publishedAt) parts.push(p.publishedAt)
    return parts.join(en ? ', ' : '，')
  })
  const head = keyword
    ? en
      ? `Found ${projects.length} open-source tools for "${keyword}": `
      : `查到 ${projects.length} 个与「${keyword}」相关的开源工具/软件：`
    : en
      ? `Found ${projects.length} open-source tools: `
      : `查到 ${projects.length} 个开源工具/软件：`
  // 提示用户可说编号选择；编号由大模型逐条念出，别吞掉。
  const tail = en
    ? 'Say the number to pick one. Details may change; check the project page for more.'
    : '想了解哪个，说编号就行。详情以项目页为准。'
  return `${head}\n${lines.join('\n')}\n${tail}`
}

/**
 * 触发口径统一带「开源」修饰，过滤前先剥离，避免「开源数据库」整串匹配不到任何条目。
 * 只剩泛义名词（项目/工具/软件…）时视为「不限品类」，返回最新项目。
 * 仅用于过滤；展示给用户仍用原始 keyword（听到的就是自己说的那句话）。
 */
export function normalizeKeyword(keyword?: string): string {
  let kw = (keyword ?? '').trim().toLowerCase()
  if (!kw) return ''
  kw = kw.replace(/open[\s_-]?source/g, '').replace(/开源/g, '').trim()
  if (/^(项目|工具|软件|应用|框架|库|project|projects|tool|tools|software|app|apps|framework|frameworks|library|libraries)$/.test(kw)) {
    return ''
  }
  return kw
}

/**
 * 按关键词过滤并截断条数。关键词匹配项目名/定位/简介/语言/系统（不区分大小写）。
 * limit 收敛到 1–5（缺省 4）；空结果返回空数组，由调用方决定文案。
 */
export function filterProjects(
  projects: OpenSourceProject[],
  keyword?: string,
  limit = 4
): OpenSourceProject[] {
  let list = projects
  const kw = normalizeKeyword(keyword)
  if (kw) {
    list = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(kw) ||
        p.title.toLowerCase().includes(kw) ||
        p.detail.toLowerCase().includes(kw) ||
        p.language.toLowerCase().includes(kw) ||
        p.os.toLowerCase().includes(kw)
    )
  }
  const lim = Math.min(Math.max(1, Math.floor(limit)), 5)
  return list.slice(0, lim)
}
