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

const FORGET_PATTERNS: RegExp[] = [
  /^忘了(.+)$/,
  /^忘记(.+)$/,
  /^别记(?:住)?(.+)$/,
  /^不要记(.+)$/,
]

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
  return null
}
