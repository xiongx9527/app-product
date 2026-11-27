/**
 * 送进 TTS 之前的文本清洗：只保留能「念」出来的内容。
 *
 * LLM 回复可能带 Markdown 或 HTML（界面按富文本渲染），但合成时：
 * - `<div>` 会被念成「div」，`&nbsp;` 念成「nbsp」；
 * - 链接地址、代码围栏、列表符号也会被逐个念出来。
 * 所以先做结构清洗（去标签、留文字），再用字符白名单兜底。
 */

/** 允许送进 TTS 的字符：中日韩文字、字母、数字、常用中英标点、空格。 */
const SPEAKABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}，。！？、；：「」『』（）,.!?;:'"() -]/u

export function sanitizeForSpeech(text: string): string {
  let out = text
    // 脚本/样式块整段丢弃
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    // 块级标签留一个空格（否则「甲</div><div>乙」会粘成「甲乙」），行内标签直接去掉
    .replace(/<\/?(br|div|p|li|ul|ol|tr|td|th|h[1-6]|section|article|blockquote|pre)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    // 流式分句可能把标签切成两半，末尾残留的半个标签也别念
    .replace(/<\/?[a-zA-Z][^>]*$/g, ' ')
    // 代码围栏（```js）
    .replace(/```[a-zA-Z0-9+#-]*/g, ' ')
    // 图片/链接只念可见文字，URL 不念
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸链接
    .replace(/https?:\/\/\S+/gi, ' ')
    // 【2026-11-27 通用】LLM 可能把工具结果里的技术路径复述进回复（真机
    // 「图表：/api/chart/image/xxx」）。绝对链接上面已剥；相对路径若残留，会被字符白名单
    // 清成「apichartimage...」念出来。按文本形态剥冗长路径（至少两段含字母），不针对字段或
    // 工具名；纯数字/日期（3/4、2026/11/27）保留。
    .replace(/\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g, (token) =>
      /[A-Za-z]/.test(token) ? ' ' : token
    )
    // HTML 实体（&nbsp; &amp; &#39;）
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    // 行首引用与列表符号
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // 分割线与表格分隔行
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')

  // 换行先变空格，否则「标题\n正文」会被字符白名单直接粘在一起
  out = out.replace(/\s+/g, ' ')

  let speakable = ''
  for (const ch of out) {
    if (SPEAKABLE.test(ch)) speakable += ch
  }
  out = speakable

  // 【2026-11-27 真机】数字小数点明确读成「点」：TTS 引擎对 "80.27" 的 "." 常静默忽略，
  // 用户听到「八十 二十七」丢小数点。断句层已保证小数不切，这里再把「数字.数字」转成
  // 「数字点数字」，确保念出来（平均分/金额等场景）。
  out = out.replace(/(\d)\.(\d)/g, '$1点$2')

  // 连续空白收敛成一个空格，避免 TTS 把一大段空白念成异常停顿
  out = out.replace(/\s+/g, ' ').trim()

  // 【2026-11-21 真机铁证】流式分句可能切出孤立标点（如单独一个「；」），白名单放行后
  // clean="；" 非空 → 送 edge-tts 合成失败（iter threw）→ 误报「这段没能播报」。
  // 若清洗后不含任何文字/字母/数字（只剩标点），返回空让 enqueue 跳过，不送 TTS。
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}]/u.test(out)) {
    return ''
  }
  return out
}
