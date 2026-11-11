import type { OpenSourceProject, OpenSourceSource } from '../types'

/** 每页条数：实测接口 pageSize 上限为 20。 */
const PAGE_SIZE = 20

/** oschina 接口单条记录（按需取字段，其余忽略）。 */
interface OschinaRecord {
  id?: number
  ident?: string | null
  name?: string
  title?: string
  detail?: string
  programmingLanguage?: string | null
  operatingSystem?: string | null
  createTime?: string
}

/** 折叠连续空白，避免播报里出现大段换行/空格。 */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 解析 oschina project/list 的单页 JSON（纯函数，便于测试）。 */
export function parseOschina(raw: string): OpenSourceProject[] {
  const data = JSON.parse(raw) as {
    result?: { records?: OschinaRecord[] }
  }
  const records = data?.result?.records ?? []
  const out: OpenSourceProject[] = []
  for (const r of records) {
    const name = collapse(r.name ?? '')
    const title = collapse(r.title ?? '')
    if (!name && !title) continue
    const ident = r.ident || r.id
    out.push({
      name: name || title,
      title,
      detail: collapse(r.detail ?? ''),
      language: collapse(r.programmingLanguage ?? ''),
      os: collapse(r.operatingSystem ?? ''),
      // 详情页：有 ident 用 ident，否则回退 id；都没有则留空，不编造链接。
      link: ident ? `https://www.oschina.net/p/${ident}` : '',
      publishedAt: (r.createTime ?? '').slice(0, 10),
    })
  }
  return out
}

/**
 * 创建「OSCHINA 开源软件」数据源。baseUrl 缺省读 OPENSOURCE_SOURCE_URL 或内置默认。
 * 分页规则：project/list?pageNum=N&pageSize=20。
 */
export function createOschinaSource(baseUrl?: string): OpenSourceSource {
  const base =
    baseUrl ??
    process.env.OPENSOURCE_SOURCE_URL ??
    'https://apiv1.oschina.net/oschinapi/project/list'
  return {
    name: 'oschina',
    baseUrl: base,
    pageUrl(page: number) {
      const sep = base.includes('?') ? '&' : '?'
      return `${base}${sep}pageNum=${page}&pageSize=${PAGE_SIZE}`
    },
    parse: parseOschina,
  }
}
