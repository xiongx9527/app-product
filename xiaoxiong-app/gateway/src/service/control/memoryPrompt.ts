/**
 * 长期记忆「问一句再记」的意图检测（2026-11-19）。
 *
 * 用户说偏好（喜欢/爱/习惯/爱好）时，不直接写记忆，而是先问「要不要记」；
 * 用户下一句若是肯定意图，再把刚才的偏好存进长期记忆。
 * 这里只做确定性检测（绕过大模型），避免误判；两个纯函数便于单测。
 */

/**
 * 偏好句检测：从用户话里抽出「要记住什么」。命中返回内容短句，否则 null。
 * 覆盖口语说法：我喜欢/我爱/我习惯/我老是/我的爱好是/我偏好/我最爱 …
 */
export function detectPreference(text: string): string | null {
  const t = (text || '').trim()
  if (!t) return null
  // 问句不是偏好陈述（「我喜欢的那首歌叫什么」是在问歌名）
  if (/[?？]|什么|哪|吗|怎么|是不是|能不能|有没有/.test(t)) return null
  // 「我（的）」+ 偏好动词 + 内容。动词含「最/很/超/挺/蛮」等程度词与「倾向于/热衷于」整体。
  // 「是」只在「爱好是/习惯是」后可选吃掉；「于」是动词一部分不能吃。
  const m = t.match(/^(?:我(?:的)?|俺)(最喜欢|最?爱|很喜欢|超喜欢|挺喜欢|蛮喜欢|喜欢|爱好|习惯|偏爱|偏好|倾向|倾向于|钟爱|热衷于)(?:是)?\s*[:：]?\s*(.+)$/)
  if (!m) return null
  let val = (m[2] ?? '').trim()
  // 去句末语气/标点
  val = val.replace(/[。．.!！~～啊呀呢吧嘛哦了]+$/g, '').trim()
  if (!val || val.length > 40) return null
  return `${m[1]}${val}`
}

/**
 * 肯定意图检测：用户回答「要不要记」时的应允。命中 true。
 * 覆盖常见口语肯定，不要求说「记一下」——用户说「好/要/行/可以/嗯/对/当然」都算。
 * 注意：保守起见，否定/含糊（不用/算了/再说/不/别）明确 false，避免误记。
 */
const AFFIRM_WORDS = /^(好|好的|好啊|好呀|行|行啊|可以|可以啊|要|要的|嗯|嗯嗯|对|对的|是的|是|当然|当然可以|没问题|成|成啊|OK|ok|okay|yes|yeah|记|记吧|记下|记下吧|记下来|记住|记一下|记一下吧|记吧|帮我记|那就记|那就记下来|那记一下|同意|随你|你记吧|你记)$/i
const NEGATE_WORDS = /^(不|不用|不要|别|算了|不必|不了|不需要|不要记|不记|取消|放弃|no|nope|再说说|再说|以后再说)$/i
/**
 * 句尾明确的「要记」短语：用户回答反问时顺带说「打球，要记下来」也能识别出肯定。
 * 必须在句尾（后面只剩语气词/标点）——「记住我喜欢吃苹果」短语后还有实质内容，那是
 * 「记住XX」指令不是确认，不能命中，否则 detectMemoryCommand 会把指令当确认放行掉。
 */
const REMEMBER_PHRASE = /(要记下来|要记一下|记下来|记一下|记住|帮我记|那就记下来|那就记一下|记下)[吧呀呢啊哦嘛了，,。！!？?\s]*$/i

/** 规范化口语肯定：去句首语气词+逗号、去句尾语气词，再匹配。
 *  如「嗯，记一下吧。」→「记一下」；「好的，记吧」→「记吧」。 */
export function normalizeAffirm(text: string): string {
  let t = (text || '').trim()
  t = t.replace(/[。．.!！?？~～\s]+$/g, '')
  // 去句首语气词 + 其后逗号：「嗯，/哦，/好的，/对，/行，/那，」
  t = t.replace(/^(嗯+|哦+|噢+|好(?:的|吧|呀|啊)?|对(?:的)?|行(?:啊)?|可以(?:啊)?|那)[，,、\s]+/, '')
  // 去句尾语气词：「吧/呀/呢/啊/哦/嘛/了」（反复去，如「记一下吧」→「记一下」）
  t = t.replace(/(吧|呀|呢|啊|哦|嘛|了)+$/g, '')
  return t.trim()
}

export function isAffirmative(text: string): boolean {
  const t = normalizeAffirm(text)
  if (!t) return false
  if (NEGATE_WORDS.test(t)) return false
  if (AFFIRM_WORDS.test(t)) return true
  // 混合句：回答了反问 + 明确说要记（「打球，要记下来」）。含记忆短语且短语前无否定即算肯定。
  // 「不用记下来 / 别记 / 不要记」不算——紧挨短语的「不/别/不用」优先否掉。
  const hit = REMEMBER_PHRASE.exec(t)
  if (!hit) return false
  const before = t.slice(0, hit.index)
  return !/(不|别|不用|没有|没)$/.test(before)
}

/** 否定意图（明确拒绝记录），用于收起提示并回一句。 */
export function isNegative(text: string): boolean {
  const t = (text || '').trim().replace(/[。．.!！?？~～,，\s]+$/g, '')
  return NEGATE_WORDS.test(t)
}


/**
 * 相似记忆合并：同一类别 key 下，新内容与已有内容合并（去重、顿号分隔），
 * 而不是覆盖掉旧的。如已有「喜欢吃苹果」+ 新「爱吃香蕉」→「喜欢吃苹果、爱吃香蕉」。
 * 完全相同则原样返回；新内容已包含旧内容（或反之）则取更全的那条。
 */
export function mergeMemoryValue(existing: string | undefined, incoming: string): string {
  const norm = (s: string) => s.replace(/\s+/g, '').trim()
  const clean = (s: string) => s.trim().replace(/^[、,，;；]+|[、,，;；]+$/g, '')
  const inc = clean(incoming)
  if (!existing) return inc
  const old = clean(existing)
  if (!old) return inc
  if (norm(old) === norm(inc)) return inc
  if (norm(old).includes(norm(inc))) return old  // 新的是旧的子串，保留更全的旧值
  if (norm(inc).includes(norm(old))) return inc  // 旧的是新的子串，取更全的新值
  // 按顿号拆成条目去重合并
  const parts = old.split(/[、,，;；]/).map(clean).filter(Boolean)
  if (!parts.some((p) => norm(p) === norm(inc))) parts.push(inc)
  return parts.join('、')
}
