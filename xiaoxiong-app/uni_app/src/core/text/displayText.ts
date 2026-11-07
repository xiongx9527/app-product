/**
 * 把模型回复整理成「能直接读」的纯文本。
 *
 * 语音助手卡片只有一段小字，模型却常按聊天习惯输出 Markdown / HTML：
 * `**加粗**`、`### 标题`、`- 列表`、`[链接](url)`、`<br>`。
 * 原样显示会看到一堆星号和井号，换行还会被 <text> 折叠成一行，观感错乱。
 * 这里只做展示层收敛：去标记、保留语义换行，不改动原始 reply（TTS 另有清洗）。
 */

/** 常见 HTML 实体还原；模型偶尔会把中文标点转义成实体 */
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
}

export function toDisplayText(raw: string): string {
  if (!raw) return ''

  let text = raw.replace(/\r\n?/g, '\n')

  // 换行类标签先转成真正的换行，其余标签整体丢弃
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  text = text.replace(/<[^>]*>/g, '')

  text = text.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? m)

  // 代码块：去掉围栏行，保留内容
  text = text.replace(/^\s*```[^\n]*$/gm, '')

  // 行内代码、图片、链接
  text = text.replace(/`([^`\n]*)`/g, '$1')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 表格分隔行整行去掉（连换行一起），单元格竖线收成空格
  text = text.replace(/^[ \t]*\|?[\s:|-]*-[\s:|-]*\|?[ \t]*$\n?/gm, '')
  text = text.replace(/\|/g, ' ')

  // 标题、引用、分割线
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

  // 列表符号：无序保留一个间隔点，有序去掉编号（念出来更顺）
  text = text.replace(/^\s*[-*+]\s+/gm, '· ')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')

  // 强调与删除线
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1$2')

  // 反斜杠转义（\* \[ 等）只留字符本身
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
