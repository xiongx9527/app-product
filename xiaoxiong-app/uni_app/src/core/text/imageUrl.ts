/**
 * 把（工具/网关下发的）图片地址规范成可加载的绝对 URL。
 * 共用于助手回复 markdown 图片（replyHtml）与报表展示区图片块（features/report）。
 *
 * - http(s) 绝对地址原样保留；
 * - 相对路径（如后端出图 /api/chart/image/xxx）以服务地址为 base 拼绝对；
 * - javascript:/data:/vbscript: 等协议一律拒绝，返回空串（安全）。
 */
export function resolveImageUrl(url: string, imageBase: string): string {
  const u = (url ?? '').trim()
  if (!u || /^(javascript|data|vbscript):/i.test(u)) return ''
  if (/^https?:\/\//i.test(u)) return u
  const base = (imageBase ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return ''
  return `${base}${u.startsWith('/') ? '' : '/'}${u}`
}
