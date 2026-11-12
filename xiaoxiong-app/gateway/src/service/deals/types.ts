import type { Lang } from '../../protocol'

/** 单条好价：只取页面上真实存在的字段，不计算页面没有的折扣率。 */
export interface Deal {
  title: string
  /** 页面上的现价文案，如「9.9元（需用券）」，原样保留「元/需用券」等信息。 */
  price: string
  /** 商城，如「京东」「天猫」。 */
  mall: string
  /** 优惠标签，如「365天新低」「手慢无」。 */
  tags: string[]
  /** 发布时间（unix 秒）。 */
  time?: number
  /** 商品详情页链接。 */
  link: string
  /** 商品主图（列表缩略图，数据源可选提供）；无图时卡片显示占位，不阻断展示。 */
  image?: string
  /** 商品大图（详情封面用）。数据源只给缩略图时可省略，客户端回退 image。 */
  imageLarge?: string
  /** 优惠/购买说明（详情页正文摘要，如「京东售价 256 元，领券后实付 91.14 元」）。列表页通常没有，抓详情页后才有。 */
  desc?: string
  /** 品牌（详情页才有）。 */
  brand?: string
  /** 数据来源标识（如 smzdm）：网关按会话 lang 查表得到展示名，客户端不认识这个 key。
   *  换源只改源解析里填的值，映射层/协议/卡片都不动。 */
  sourceKey?: string
}

/**
 * 详情页补充信息：列表页信息量有限（价格、商城、几条标签），选中某件后再抓它的详情页
 * 可以补出优惠说明、权威发布时间、更清晰的主图。字段全部可选——抓不到就当没有，
 * 绝不因为详情页失败而让卡片打不开（列表数据已经在手）。
 */
export interface DealDetail {
  desc?: string
  brand?: string
  /** 权威发布时间（unix 秒），覆盖列表页的近似值 */
  time?: number
  imageLarge?: string
}

/**
 * 好价数据源契约。抓什么值得买「精选好价」只是其中一个实现；
 * 后续接其它源（官方/付费/其它站点）时，只需新增一个 DealsSource 实现，
 * 工具与播报层（tools/dealsTool）无需改动。
 */
export interface DealsSource {
  /** 数据源标识，仅用于日志/调试，不向用户暴露。 */
  name: string
  /** 首页地址（换源只改这里/配置）。 */
  baseUrl: string
  /** 按页码生成要抓取的页面 URL；page<=1 返回首页。 */
  pageUrl(page: number): string
  /** 解析列表页 HTML 为 Deal[]（失败抛错，由上层降级）。 */
  parse(html: string): Deal[]
  /** 该条目的详情页地址；不实现表示这个源没有详情页可补。 */
  detailUrl?(deal: Deal): string | undefined
  /** 解析详情页 HTML 为补充信息（纯函数；解析不出就返回空对象，由上层容忍）。 */
  parseDetail?(html: string): DealDetail
  /**
   * 按关键词的站内真搜索页 URL；返回空串表示该页不存在（如超出分页）。
   * 不实现时带关键词的查询退回「抓 feed + 本地过滤」，只能搜到 feed 里的商品。
   */
  searchUrl?(keyword: string, page: number): string
  /** 解析搜索页 HTML 为 Deal[]；缺省复用 parse（搜索页与 feed 同构时才可省）。 */
  parseSearch?(html: string): Deal[]
}

/** 抓取器：测试可注入桩，避免真实联网。 */
export type DealsFetcher = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** 创建好价工具时的可选项（数据源可插拔；缓存/分页/抓取器为通用配置）。 */
export interface DealsOptions {
  /** 好价数据源，由外部（组合根）注入，工具本身不绑定任何具体站点。 */
  source: DealsSource
  /** 列表缓存时间（毫秒）。缺省读 DEALS_CACHE_TTL_MS 或 60000。 */
  cacheTtlMs?: number
  /** 关键词查询最多抓几页。缺省读 DEALS_KEYWORD_PAGES 或 3。 */
  keywordPages?: number
  /** 默认推荐条数：LLM 未显式指定 limit 时使用的条数，缺省 3，范围 1–10（由客户端设置页下发）。 */
  defaultLimit?: number
  /** 注入抓取器（默认全局 fetch）。 */
  fetcher?: DealsFetcher
}

/** 把若干好价格式化成本地化纯文本，交给大模型组织成一句语音播报。 */
export function formatDeals(
  lang: Lang | string,
  deals: Deal[],
  keyword?: string
): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const en = prefix === 'en'
  if (!deals.length) {
    return keyword
      ? en
        ? `No deals found for "${keyword}".`
        : `没找到与「${keyword}」相关的好价。`
      : en
        ? 'No deals found right now.'
        : '暂时没有查到好价。'
  }
  const lines = deals.map((d, i) => {
    const parts = [`${i + 1}. ${d.title}`]
    if (d.price) parts.push(en ? `price ${d.price}` : `现价${d.price}`)
    if (d.mall) parts.push(d.mall)
    if (d.tags.length) parts.push(d.tags.join(en ? ' / ' : '、'))
    return parts.join(en ? ', ' : '，')
  })
  const head = keyword
    ? en
      ? `Found ${deals.length} deals for "${keyword}": `
      : `查到 ${deals.length} 件与「${keyword}」相关的好价：`
    : en
      ? `Found ${deals.length} latest deals: `
      : `查到 ${deals.length} 件最新好价：`
  const tail = en
    ? 'Prices change fast; check the product page before ordering.'
    : '价格变化快，下单前以商品页为准。'
  return `${head}\n${lines.join('\n')}\n${tail}`
}

/**
 * 常见品类后缀表：把「降噪耳机」这类复合词拆成「降噪 + 耳机」两个词段做 AND 匹配，
 * 让回退过滤能命中「真无线降噪 蓝牙耳机」这类拆写标题（整串 includes 会漏）。
 * 按长度降序取最长后缀；只收高频品类词不追求全覆盖——不在表里的词整串匹配（原逻辑）。
 */
const CATEGORY_SUFFIXES = [
  '空气炸锅', '扫地机器人', '无线耳机', '蓝牙耳机', '头戴耳机', '充电宝', '保温杯',
  '显示器', '洗衣机', '电饭煲', '投影仪', '路由器', '吹风机', '剃须刀', '加湿器',
  '打印机', '笔记本', '耳机', '音箱', '音响', '键盘', '鼠标', '手机', '电脑',
  '手表', '电视', '冰箱', '空调', '相机', '镜头', '球鞋', '跑鞋', '运动鞋',
  '鞋子', '背包', '台灯', '牙刷', '风扇', '雨伞', '杯子',
].sort((a, b) => b.length - a.length)

/**
 * 把关键词拆成一组「都必须出现」的词段：按空白拆 token，token 若以品类后缀结尾
 * 且还有前缀，则拆成 [前缀, 品类]（「降噪耳机」→ [降噪, 耳机]）；否则整串一个词段。
 * 纯函数，供 filterDeals 与单测使用。
 */
export function splitKeywordTerms(keyword: string): string[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  const terms: string[] = []
  for (const t of kw.split(/\s+/).filter(Boolean)) {
    const suffix = CATEGORY_SUFFIXES.find((s) => t.length > s.length && t.endsWith(s))
    if (suffix) {
      // token 比后缀长才有前缀；「耳机」本身长度相等，整串匹配（等价原逻辑）
      terms.push(t.slice(0, t.length - suffix.length), suffix)
    } else {
      terms.push(t)
    }
  }
  return terms
}

/**
 * 按关键词过滤并截断条数。复合关键词拆词后做 AND 匹配：每个词段都要在
 * 标题 / 商城 / 标签任一处出现（不区分大小写）。单词行为与整串 includes 等价。
 * limit 收敛到 1–10（缺省 3）；空结果返回空数组，由调用方决定文案。
 */
export function filterDeals(
  deals: Deal[],
  keyword?: string,
  limit = 3
): Deal[] {
  let list = deals
  const terms = splitKeywordTerms(keyword ?? '')
  if (terms.length) {
    list = deals.filter((d) =>
      terms.every(
        (t) =>
          d.title.toLowerCase().includes(t) ||
          d.mall.toLowerCase().includes(t) ||
          d.tags.some((tag) => tag.toLowerCase().includes(t))
      )
    )
  }
  const lim = Math.min(Math.max(1, Math.floor(limit)), 10)
  return list.slice(0, lim)
}
