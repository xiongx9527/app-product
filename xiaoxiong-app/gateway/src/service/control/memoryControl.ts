/**
 * 记忆类直接指令（绕过 LLM，确定性命中）：语音「忘了XX / 忘记XX / 别记XX / 清空记忆」。
 * 与音乐直连同理——意图明确、不需要模型判断，直接落地更可靠，也不会被模型幻觉成「说忘了却没忘」。
 *
 * 注意：只在句首出现明确的遗忘动词时才命中，避免把普通闲聊（如「我忘了带钥匙」这种陈述）
 * 误判成「请删除记忆」。其中「不记得/不记得了」是用户的记忆缺失陈述，不是删除指令，不命中。
 */
export type MemoryCommand =
  | { action: 'forget'; topic: string }
  | { action: 'clear' }
  | { action: 'remember'; key: string; value: string }

const FORGET_PATTERNS: RegExp[] = [
  /^忘了(.+)$/,
  /^忘记(.+)$/,
  /^别记(?:住)?(.+)$/,
  /^不要记(.+)$/,
]

/**
 * 「记住XX」直连：与「忘了XX」对称，绕过 LLM 确定性落地。
 * 支持「话题：内容 / 话题，内容」分隔；无分隔时整句作为内容，话题取剥掉主语前缀后的主体，
 * 保证每条记忆独立（同 key 才覆盖更新），避免把不同习惯堆进同一条。
 */
const REMEMBER_PATTERNS: RegExp[] = [
  /^记住(.+)$/,
  /^记录(?:一下|下)?(.+)$/,
  /^记一下(.+)$/,
  /^记着(.+)$/,
  /^帮我记(?:住)?(.+)$/,
  /^记一个(.+)$/,
  /^记下来(.+)$/,
]

function parseRemember(body: string): { key: string; value: string } {
  const text = body.replace(/^[\s,，:：]+/, '').trim()
  const sep = text.match(/^(.*?)[：:，,]+(.+)$/)
  if (sep && sep[1].trim() && sep[2].trim()) {
    return { key: sep[1].trim(), value: sep[2].trim() }
  }
  // 无分隔符：剥掉「我（的）/俺/咱们」等主语前缀当话题标签，value 保留原句
  const key = text.replace(/^(我(?:的)?|俺|咱们?|我们)/, '').trim() || text
  return { key, value: text }
}

const CLEAR_PATTERNS: RegExp[] = [
  /^清空记忆$/,
  /^清除记忆$/,
  /^清除我的记忆$/,
  /^清空我的记忆$/,
  /^删除记忆$/,
  /^删掉记忆$/,
  /^去掉记忆$/,
  /^把我记住的都忘掉$/,
  /^忘掉全部记忆$/,
  /^忘了$/,
]

export function detectMemoryCommand(text: string): MemoryCommand | null {
  const t = (text ?? '').trim()
  if (!t) return null
  for (const p of CLEAR_PATTERNS) {
    if (p.test(t)) return { action: 'clear' }
  }
  for (const p of FORGET_PATTERNS) {
    const m = t.match(p)
    if (m) {
      const topic = (m[1] ?? '').trim()
      // 只说「忘了」没给话题：当作清空意图，避免空 topic 命中全盘
      if (!topic) return { action: 'clear' }
      return { action: 'forget', topic }
    }
  }
  for (const p of REMEMBER_PATTERNS) {
    const m = t.match(p)
    if (m) {
      const body = (m[1] ?? '').trim()
      if (!body) return null
      return { action: 'remember', ...parseRemember(body) }
    }
  }
  return null
}
