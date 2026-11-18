/**
 * 百科数据源域：显式多源架构。
 *
 * 百度百科只是其中一个源（默认）。所有源实现 BaikeSource 接口，工具层与直连只依赖接口，
 * 不绑定任何具体站点。新增源两步：① 新建 xxxBaikeSource.ts 实现接口；② 在下面注册表登记一行。
 * 组合根可按名字注入指定源，缺省用默认源。换源不碰取数/格式化逻辑（同 weather / deals 范式）。
 */
import type { BaikeSource } from './types'
import { createBaiduBaikeSource } from './baidu/baiduBaikeSource'

export type { BaikeEntry, BaikeFetcher, BaikeSource } from './types'
export { createBaiduBaikeSource, parseBaikeHtml, cleanBaikeText } from './baidu/baiduBaikeSource'

/** 源工厂注册表：key 为源名（小写），值为工厂。百度只是默认的一个。 */
const BAIKE_SOURCE_FACTORIES: Record<string, () => BaikeSource> = {
  baidu: createBaiduBaikeSource,
  // 后续源在此登记，例如：
  // zhwiki: createZhWikiBaikeSource,
}

/** 默认源名：换默认源只改这里一行。 */
export const DEFAULT_BAIKE_SOURCE = 'baidu'

/** 列出全部可用源名（用于配置/调试）。 */
export function listBaikeSources(): string[] {
  return Object.keys(BAIKE_SOURCE_FACTORIES)
}

/** 按名字创建源；未知名字回退默认源。 */
export function createBaikeSource(name?: string): BaikeSource {
  const key = (name || DEFAULT_BAIKE_SOURCE).toLowerCase()
  const factory = BAIKE_SOURCE_FACTORIES[key] ?? BAIKE_SOURCE_FACTORIES[DEFAULT_BAIKE_SOURCE]
  return factory()
}

/** 默认源工厂——组合根缺省用这个；换默认源改 DEFAULT_BAIKE_SOURCE 即可。 */
export function createDefaultBaikeSource(): BaikeSource {
  return createBaikeSource()
}
