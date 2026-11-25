/**
 * 把模型回复转成 `rich-text` 能渲染的 HTML。
 *
 * 模型回复有两种常见形态：
 * 1. 直接给 HTML（`<div>`、`<br>`、`<ul>`…），希望被当成富文本展示；
 * 2. 给 Markdown（`**加粗**`、`### 标题`、`- 列表`、代码块），原样显示就是一堆符号。
 *
 * 这里统一收敛成安全的内联样式 HTML：
 * - 已经是 HTML 的原样保留，但去掉 script / iframe / on* 事件 / javascript: 链接；
 * - Markdown 先转义再按块级结构转换；
 * - 样式必须内联，`rich-text` 内部节点拿不到页面 scoped CSS。
 */

const BLOCK_TAG =
  /<(div|p|br|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|pre|blockquote|section|article|hr)\b[^>]*>/i

/** 出现任意已知标签就按 HTML 处理（含行内标签），否则按 Markdown 处理 */
const ANY_TAG =
  /<(div|p|br|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|pre|blockquote|section|article|hr|span|strong|b|em|i|u|s|del|code|a|img|sub|sup|font)\b[^>]*>/i

const COLOR_TEXT = '#e8eaf6'
const COLOR_MUTED = '#9aa1bd'
const COLOR_ACCENT = '#6c8cff'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESCAPES[ch])
}

/** 去掉可执行内容：脚本、内联事件、javascript: 链接。rich-text 不执行脚本，但 H5 用 innerHTML。 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // href/src 可能是带引号或裸写的，统一检查 javascript: 协议
    .replace(
      /\b(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (match, attr: string) => (/javascript:/i.test(match) ? `${attr}="#"` : match)
    )
}

/**
 * 把图片地址规范成可加载的绝对 URL。
 * - 工具返回的图表是相对路径（如 /api/chart/image/xxx），拼到服务地址上；
 * - 已经是 http(s) 绝对地址的原样保留；
 * - javascript:/data:/vbscript: 等协议一律拒绝（安全），返回空串。
 */
function resolveImageUrl(url: string, imageBase: string): string {
  const u = (url ?? '').trim()
  if (!u || /^(javascript|data|vbscript):/i.test(u)) return ''
  if (/^https?:\/\//i.test(u)) return u
  // 相对路径：以服务地址为 base（服务地址本身已是 http(s)）
  const base = (imageBase ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return ''
  return `${base}${u.startsWith('/') ? '' : '/'}${u}`
}

/** 图片基址：由 toReplyHtml 的 imageBase 参数设置（服务地址），用于把相对图片 URL 拼成绝对地址。 */
let currentImageBase = ''

/** 行内标记：代码、加粗、斜体、删除线、链接、图片。入参必须是已转义的文本。 */
function inline(text: string): string {
  let out = text
  // 图片 ![alt](url) → <img>。必须在链接 [text](url) 之前处理，否则 ! 会被当成普通文本、
  // 且链接正则会错误吞掉图片语法。url 经 resolveImageUrl 校验，杜绝危险协议。
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (match, alt: string, url: string) => {
      const src = resolveImageUrl(url, currentImageBase)
      if (!src) return alt || ''
      const safeAlt = alt.replace(/"/g, '&quot;')
      return `<img src="${src}" alt="${safeAlt}" style="max-width:100%;height:auto;border-radius:8px;margin:6px 0;display:block" />`
    }
  )
  out = out.replace(
    /`([^`]+)`/g,
    `<code style="font-family:Menlo,Consolas,monospace;font-size:12px;background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;color:${COLOR_TEXT}">$1</code>`
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  // App 端 rich-text 的 <a> 不可点击，链接只做视觉强调，避免点了没反应
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    `<span style="color:${COLOR_ACCENT};text-decoration:underline">$1</span>`
  )
  return out
}

function renderMarkdown(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let listOpen: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`)
      listOpen = null
    }
  }
  const openList = (kind: 'ul' | 'ol') => {
    if (listOpen === kind) return
    closeList()
    out.push(`<${kind} style="margin:4px 0;padding-left:18px;color:${COLOR_TEXT}">`)
    listOpen = kind
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块：整段原样保留，内部不解析行内标记
    const fence = line.match(/^\s*```/)
    if (fence) {
      closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      out.push(
        `<pre style="margin:6px 0;padding:8px 10px;background:rgba(255,255,255,0.06);border-radius:6px;overflow-x:auto"><code style="font-family:Menlo,Consolas,monospace;font-size:12px;color:${COLOR_TEXT}">${escapeHtml(
          body.join('\n')
        )}</code></pre>`
      )
      continue
    }

    if (!line.trim()) {
      closeList()
      out.push('<br/>')
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const size = heading[1].length <= 2 ? 16 : 14
      out.push(
        `<div style="font-size:${size}px;font-weight:600;margin:6px 0 2px;color:${COLOR_TEXT}">${inline(
          escapeHtml(heading[2])
        )}</div>`
      )
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList()
      out.push('<div style="height:1px;background:rgba(255,255,255,0.12);margin:8px 0"></div>')
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      openList('ul')
      out.push(`<li style="margin:2px 0">${inline(escapeHtml(bullet[1]))}</li>`)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ordered) {
      openList('ol')
      out.push(`<li style="margin:2px 0">${inline(escapeHtml(ordered[1]))}</li>`)
      continue
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/)
    if (quote) {
      closeList()
      out.push(
        `<div style="border-left:2px solid ${COLOR_ACCENT};padding-left:8px;margin:4px 0;color:${COLOR_MUTED}">${inline(
          escapeHtml(quote[1])
        )}</div>`
      )
      continue
    }

    // 表格：分隔行丢弃，其余行把单元格用间隔点连起来（语音场景不需要对齐表格）
    if (/^\s*\|/.test(line)) {
      closeList()
      if (/^[ \t]*\|?[\s:|-]*-[\s:|-]*\|?[ \t]*$/.test(line)) continue
      const cells = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
      out.push(
        `<div style="margin:2px 0;color:${COLOR_TEXT}">${inline(escapeHtml(cells.join(' · ')))}</div>`
      )
      continue
    }

    closeList()
    out.push(`${inline(escapeHtml(line))}<br/>`)
  }

  closeList()
  return cleanArtifacts(out.join('').replace(/(<br\/>)+$/, ''))
}

/**
 * 清理模型流式输出里常见的残留，避免卡片上出现一堆符号怪文：
 * - 没配对的强调符（** / __ / ~~）：markdown 转换只吃掉成对的，落单的会原样显示；
 * - 连续句点 / 省略号堆积（... / ………）：收敛成一个省略号；
 * - 连续破折号（— — / --）：收敛成一个。
 * 只在转换后的 HTML 文本上做，不会误伤我们自己生成的标签属性（用中文标点与空格分隔）。
 */
function cleanArtifacts(html: string): string {
  return html
    .replace(/\*\*+|__+|~~+/g, '')
    .replace(/(?:\.{3,}|\u2026{2,})/g, '\u2026')
    .replace(/[—–\-]\s*[—–\-]+/g, '—')
}

export function toReplyHtml(raw: string, imageBase = ''): string {
  currentImageBase = imageBase ?? ''
  if (!raw) return ''
  const src = raw.replace(/\r\n?/g, '\n').trim()
  if (!src) return ''

  // 已经是 HTML：只做安全清洗；没有块级标签时把换行补成 <br/>
  if (ANY_TAG.test(src)) {
    let safe = sanitizeHtml(src)
    // <img src="相对路径"> 拼服务地址（工具返回的图表 URL 是相对的 /api/chart/image/xxx）
    safe = safe.replace(
      /\b(src)\s*=\s*(["'])([^"']*)\2/gi,
      (match, attr: string, quote: string, url: string) => {
        const resolved = resolveImageUrl(url, currentImageBase)
        return resolved ? `${attr}=${quote}${resolved}${quote}` : match
      }
    )
    return BLOCK_TAG.test(safe) ? safe : safe.replace(/\n/g, '<br/>')
  }

  return renderMarkdown(src)
}
