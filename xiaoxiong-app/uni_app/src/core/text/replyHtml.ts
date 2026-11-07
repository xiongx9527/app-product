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

/** 行内标记：代码、加粗、斜体、删除线、链接。入参必须是已转义的文本。 */
function inline(text: string): string {
  let out = text
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
  return out.join('').replace(/(<br\/>)+$/, '')
}

export function toReplyHtml(raw: string): string {
  if (!raw) return ''
  const src = raw.replace(/\r\n?/g, '\n').trim()
  if (!src) return ''

  // 已经是 HTML：只做安全清洗；没有块级标签时把换行补成 <br/>
  if (ANY_TAG.test(src)) {
    const safe = sanitizeHtml(src)
    return BLOCK_TAG.test(safe) ? safe : safe.replace(/\n/g, '<br/>')
  }

  return renderMarkdown(src)
}
