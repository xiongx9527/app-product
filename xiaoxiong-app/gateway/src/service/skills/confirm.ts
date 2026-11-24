/**
 * 通用「反问确认」判定（问一句后用户答「好/不用」），纯函数、不绑死任何业务。
 * 与 preference_skill/memoryPrompt.ts 的区别：那边混了「记下来」等记忆专属短语；
 * 这里只判纯口语肯定/否定，供 detail_chat 等「要不要介绍」类反问共用。
 */

/** 去句首语气词+逗号、句尾语气词+标点，得到核心词。 */
export function normalizeConfirm(text: string): string {
  let t = (text || '').trim()
  t = t.replace(/[。．.!！?？~～\s,，]+$/g, '')
  t = t.replace(/^(嗯+|哦+|噢+|那|好(?:的|吧|呀|啊)?|对(?:的)?|行(?:啊)?|可以(?:啊)?)[，,、\s]+/, '')
  t = t.replace(/(吧|呀|呢|啊|哦|嘛|了)+$/g, '')
  return t.trim()
}

const AFFIRM = /^(好|好的|好啊|好呀|行|行啊|可以|可以啊|要|要的|要啊|嗯|嗯嗯|对|对的|是的|是|当然|当然可以|没问题|成|成啊|介绍|介绍一下|介绍一下吧|讲讲|说说|OK|ok|okay|yes|yeah|来吧|那就介绍|那就介绍一下)$/i
const NEGATE = /^(不|不用|不要|别|算了|不必|不了|不需要|不介绍|不用介绍|不要介绍|取消|no|nope|再说说|再说|以后再说|不用了|不了吧)$/i

/** 用户明确应允「要不要介绍」类反问。保守：否定/含糊一律 false。 */
export function isConfirmYes(text: string): boolean {
  const t = normalizeConfirm(text)
  if (!t) return false
  if (NEGATE.test(t)) return false
  return AFFIRM.test(t)
}

/** 用户明确拒绝。 */
export function isConfirmNo(text: string): boolean {
  const t = (text || '').trim().replace(/[。．.!！?？~～,，\s]+$/g, '')
  return NEGATE.test(t)
}
