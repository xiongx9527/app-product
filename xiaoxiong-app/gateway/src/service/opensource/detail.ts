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
  const m = messages(lang).opensource
  const labels = m.fieldLabels
  return projects.map((p, i) => {
    const fields: DetailField[] = []
    if (p.title) fields.push({ label: labels.tagline(), value: p.title })
    // 用户要看的字段即使源没给值也留一行占位：不编造具体语言/协议，但字段不消失。
    // 等值就显示「暂无」，换到有该字段的源（GitHub 等）时自动变成真值，客户端不用改。
    const empty = m.emptyValue
    fields.push({ label: labels.language(), value: p.language || empty() })
    fields.push({ label: labels.license(), value: p.license || empty() })
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
      // 不放 image：oschina 的 oscimg 图床校验 Referer，浏览器带 localhost 会 403，
      // 直连只会在列表里显示空方块。商品图域名不查 Referer，故商品仍照常带图。
      // 以后要走代理再在网关加图片转发，协议槽位不变。
      link: p.link || undefined,
      fields: fields.length ? fields : undefined,
    }
  })
}
