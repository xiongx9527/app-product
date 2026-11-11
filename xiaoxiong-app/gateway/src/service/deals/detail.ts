import type { DetailField, DetailItem, Lang } from '../../protocol'
import { messages } from '../../i18n'
import type { Deal } from './types'

/**
 * 发布时间 → 本地时间展示串 "YYYY-MM-DD HH:mm"。
 *
 * 数据源的时间字段并不统一（见过 10 位秒、13 位毫秒，也见过页面未渲染的模板占位符），
 * 这里统一收敛：>1e12 当毫秒、否则当秒；换算后年份不在 2000–2100 的（含 Invalid Date
 * 与解析成负数年的脏值）一律返回空串，由调用方省略该字段——宁可少一行，
 * 也不把「-1 年」这种垃圾值摆到卡片上。用本地时区，因为网关就装在用户自己机器上。
 */
function formatTime(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000
  const d = new Date(ms)
  const y = d.getFullYear()
  if (!Number.isFinite(ms) || !Number.isFinite(y) || y < 2000 || y > 2100) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 数据源模型 → 协议层统一字段契约的映射（网关侧唯一桥接）。
 *
 * 「字段规划统一」：下发给客户端的 `DetailItem` 只有固定槽位 + 统一 `fields[]`，
 * 不含任何来源专属字段。内部 `Deal` 可随数据源自由增删字段；新增数据源或新字段
 * 只改这个映射（及网关 i18n 标签），不改协议、事件、卡片容器、客户端状态结构。
 * label 由网关按会话 lang 本地化，客户端只逐行渲染 label+value、不认识具体字段名。
 */
export function toDetailItems(
  deals: readonly Deal[],
  lang: Lang | string = 'zh-CN',
): DetailItem[] {
  const labels = messages(lang).deals.fieldLabels
  const en = (lang || '').toLowerCase().split(/[-_]/)[0] === 'en'
  const sep = en ? ', ' : '、'
  return deals.map((d, i) => {
    const fields: DetailField[] = []
    if (d.price) fields.push({ label: labels.price(), value: d.price })
    if (d.mall) fields.push({ label: labels.mall(), value: d.mall })
    if (d.brand) fields.push({ label: labels.brand(), value: d.brand })
    if (d.tags?.length) fields.push({ label: labels.tags(), value: d.tags.join(sep) })
    if (d.desc) fields.push({ label: labels.desc(), value: d.desc })
    if (d.time && Number.isFinite(d.time)) {
      const when = formatTime(d.time)
      // 解析不出可信时间就不显示这行，不留「-1-11-29」这类脏值
      if (when) fields.push({ label: labels.time(), value: when })
    }
    if (d.sourceKey) {
      // 放最前：列表只预览前几条短字段，来源要能被看到
      fields.unshift({ label: labels.source(), value: messages(lang).sources[d.sourceKey] ?? d.sourceKey })
    }
    return {
      index: i + 1,
      title: d.title,
      image: d.image || undefined,
      imageLarge: d.imageLarge || undefined,
      link: d.link || undefined,
      fields: fields.length ? fields : undefined,
    }
  })
}
