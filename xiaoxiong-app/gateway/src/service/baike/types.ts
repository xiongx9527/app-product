/**
 * 百科数据源的抽象契约（可换源）。
 *
 * 百科工具/直连只依赖 BaikeSource 接口，不绑定任何具体站点。
 * 换源（如换其它百科站）只需实现接口并在组合根注入，不用改工具的取数/格式化逻辑。
 * 设计参照 weather / deals 的 source 范式：source 负责「去哪取 + 怎么解析成统一结构」，
 * 工具层负责「把统一结构格式化成口播文案」，两者解耦。
 *
 * 默认实现见 baiduBaikeSource.ts：抓百度搜索结果页，取「百度百科」卡片的摘要。
 * 之所以抓搜索页而不是词条页 /item/：词条页有百度安全验证（403），
 * 而搜索结果 JSON 里自带百科摘要（description / abstract），无需点进词条、无需 api-key。
 */

/** 统一中间结构：任何百科源都把原始响应解析成这个形状。 */
export interface BaikeEntry {
  /** 词条标题（清洗后，不含 <em> 高亮标签、不含「 - 百度百科」后缀） */
  title: string
  /** 词条摘要（清洗后的纯文本，用于助手框显示 + TTS 播报） */
  summary: string
  /** 词条原始链接（可选，来自搜索卡片） */
  url?: string
}

/**
 * 底层 HTTP 拉取函数：默认全局 fetch，测试可注入桩，避免真实联网。
 * 第二参带请求头（UA 等），百度对裸 curl 有反爬——签名与 DealsFetcher 一致。
 */
export type BaikeFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; text: () => Promise<string> }>

/**
 * 百科源接口：给定查询词取回统一结构；失败/无结果返回 null（由工具层给友好兜底文案）。
 * fetcher 由工具层注入，source 不直接依赖全局 fetch，便于测试。
 */
export interface BaikeSource {
  /** 数据源标识，仅用于日志/调试，不向用户暴露。 */
  name: string
  fetch(query: string, fetcher: BaikeFetcher): Promise<BaikeEntry | null>
}
