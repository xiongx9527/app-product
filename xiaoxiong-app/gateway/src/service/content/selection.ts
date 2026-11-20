/**
 * 通用语音选号解析（系统层，与内容类型无关）。
 *
 * 「第几首 / 第二个 / 第三件 / 2 / 就第3首」这类编号，以及直接说名字，
 * 在音乐候选、新闻候选、商品候选里完全一样，故收在系统层，不归任何内容 skill。
 * 只读候选的 .title，不认识业务类型。
 */
import type { ContentCandidate } from './types'

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/** 归一化：去空白与标点，便于比对标题/序号。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 编号量词：音乐说「首/个」，商品说「件」，开源项目说「个/项」，统一在这里认。 */
const ORDINAL_UNIT = '首个件条项款'

function toNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  return CN_NUM[raw] ?? null
}

/**
 * 把用户下一句话解析成候选列表里的选择，返回 0-based 索引；不是选择返回 null。
 * 支持「第一首 / 第二个 / 第三件 / 2 / 就第3首」等序号，以及直接说名字。
 * 注意：「再来一首 / 换一首」里的「一」是量词不是序号，必须排除，否则会被误判成选第 1 首。
 */
export function parseSelection(text: string, candidates: readonly ContentCandidate[]): number | null {
  if (!candidates.length) return null
  const norm = normalize(text)
  if (!norm) return null
  const ordinal = new RegExp(`第([一二两三四五六七八九十\\d]+)[${ORDINAL_UNIT}]?`).exec(norm)
  if (ordinal) {
    const num = toNumber(ordinal[1])
    if (num !== null && num >= 1 && num <= candidates.length) return num - 1
  }
  const bare = new RegExp(`^([一二两三四五六七八九十\\d]+)[${ORDINAL_UNIT}]?$`).exec(norm)
  if (bare) {
    const num = toNumber(bare[1])
    if (num !== null && num >= 1 && num <= candidates.length) return num - 1
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const title = normalize(candidates[i].title)
    if (title && norm.includes(title)) return i
  }
  return null
}

/**
 * 这句话是否「像是在报编号」（含「第X」或整句就是序号），不要求解析出具体编号。
 * 用于选号失败时决定「口播重问并留住列表」还是「放行到正常流程」。
 * 「几」要算进来——用户说「第几个」往往是在找词，不该被丢给大模型。
 */
export function looksLikeSelectionAttempt(text: string): boolean {
  const norm = normalize(text)
  if (!norm) return false
  return (
    new RegExp(`第[一二两三四五六七八九十\\d几]+[${ORDINAL_UNIT}]?`).test(norm) ||
    new RegExp(`^[一二两三四五六七八九十\\d]+[${ORDINAL_UNIT}]?$`).test(norm)
  )
}
