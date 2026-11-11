import type { DetailField, DetailItem, Lang } from '../../protocol'
import { messages } from '../../i18n'
import type { OpenSourceProject } from './types'

/**
 * 开源项目模型 → 协议层统一字段契约的映射（与商品详情同一套 `DetailItem` 形状）。
 *
 * 「外面无感知」：客户端只看到固定槽位（index/title/link）+ `fields[{label,value}]`，
 * 不知道数据来自 oschina 还是 GitHub、来自列表接口还是详情页。换源只改这里与源自身解析，
 * 协议、事件、卡片容器、客户端渲染逻辑一律不动。
 */
export function projectsToDetailItems(
  projects: readonly OpenSourceProject[],
  lang: Lang | string = 'zh-CN',
): DetailItem[] {
  const labels = messages(lang).opensource.fieldLabels
  return projects.map((p, i) => {
    const fields: DetailField[] = []
    if (p.title) fields.push({ label: labels.tagline(), value: p.title })
    if (p.language) fields.push({ label: labels.language(), value: p.language })
    if (p.license) fields.push({ label: labels.license(), value: p.license })
    if (p.os) fields.push({ label: labels.os(), value: p.os })
    if (p.publishedAt) fields.push({ label: labels.time(), value: p.publishedAt })
    // 简介可能很长，放最后；列表渲染器会跳过过长 value，详情里仍展示全文
    if (p.detail) fields.push({ label: labels.desc(), value: p.detail })
    if (p.sourceKey) {
      fields.unshift({ label: labels.source(), value: messages(lang).sources[p.sourceKey] ?? p.sourceKey })
    }
    return {
      index: i + 1,
      title: p.name,
      image: p.image || undefined,
      link: p.link || undefined,
      fields: fields.length ? fields : undefined,
    }
  })
}
