/**
 * 好价/商品 skill：识别「找好价/打折/便宜货/查商品/推荐 XX」→ 抓真实商品数据，
 * 编号列表让用户语音选，选中后补抓详情走 media.detail 展示。业务全在本目录
 * （detect/i18n/run/源/工具）。
 *
 * 网关编排层只按 priority 把话递给 onDirectCommand 与 onCandidateSelection，不含商品业务。
 * 源可替换：query / detail 由构造注入（换源/测试桩不改本 skill 代码）。
 * 跨轮候选（pending deals）放本 skill 闭包，与内容候选互斥经通用钩子协调。
 */
import { detectDealsCommand, detectProductQuery } from './detect'
import { messages } from '../../../i18n'
import { toDetailItems, formatDeals } from './deals'
import type { Deal, DealDetail } from './deals'
import type { DealsSnapshot } from './deals'
import { pickDeals } from './preference'
import { createDealsQuery, enrichDeal } from './query'
import { createDealsSource, createDealsAllSources } from './deals'
import type { Skill, SkillContext, SkillModule } from '../types'
import type { ContentCandidate } from '../../content/types'
import { parseSelection, looksLikeSelectionAttempt } from '../../content/selection'

export interface DealsDeps {
  /** 一次查询 → 口播文本 + 结构化 Deal[]；keyword 为具体商品名，dealsOnly 限定好价。 */
  query?: (keyword?: string | null, dealsOnly?: boolean) => Promise<DealsSnapshot>
  /** 补抓选中商品详情；失败返回 null（卡片退回列表数据）。 */
  detail?: (deal: Deal) => Promise<DealDetail | null>
}

function makeDealsSkill(ctx: SkillContext, deps: DealsDeps): Skill {
  let pending: { items: Deal[]; query: string } | null = null
  const clear = () => { pending = null }

  async function run(keyword?: string | null, dealsOnly = false): Promise<void> {
    const i = messages(ctx.lang).deals
    const query = deps.query ?? (() => Promise.resolve({ text: formatDeals(ctx.lang, []), deals: [] }))
    try {
      const { text, deals } = await query(keyword, dealsOnly)
      // 按长期记忆偏好挑 3 件（纯函数，不调 LLM）；没记忆时等价取前 3 件。
      const prefs = ctx.getPreferenceKeywords ? await ctx.getPreferenceKeywords() : []
      const picked = pickDeals(deals, prefs, 3)
      if (picked.length) {
        pending = { items: picked, query: '' }
        ctx.send({ type: 'media.detail', kind: 'deals', items: toDetailItems(picked, ctx.lang) })
        await ctx.speak(`${i.candidates(picked.map((d) => d.title))}${i.chooseHint()}`)
      } else {
        clear()
        ctx.send({ type: 'media.detail', kind: 'deals', items: [], close: true })
        await ctx.speak(text)
      }
    } catch {
      await ctx.speak(formatDeals(ctx.lang, []))
    }
  }

  async function select(text: string): Promise<boolean> {
    if (!pending?.items.length) return false
    const candidates: ContentCandidate[] = pending.items.map((d) => ({ title: d.title }))
    const idx = parseSelection(text, candidates)
    if (idx === null) {
      if (looksLikeSelectionAttempt(text)) {
        ctx.send({ type: 'asr.final', text, queueRemaining: ctx.queueRemaining() })
        await ctx.speak(messages(ctx.lang).deals.chooseAgain())
        return true
      }
      return false
    }
    const items = pending.items
    clear()
    ctx.send({ type: 'asr.final', text, queueRemaining: ctx.queueRemaining() })
    const spoken = ctx.speak(messages(ctx.lang).deals.detailIntro(idx + 1))
    let detail: DealDetail | null = null
    if (deps.detail) {
      try { detail = await deps.detail(items[idx]) } catch { detail = null }
    }
    const merged = detail ? items.map((d, i) => (i === idx ? { ...d, ...detail } : d)) : items
    ctx.send({
      type: 'media.detail',
      kind: 'deals',
      items: toDetailItems(merged, ctx.lang),
      selectedIndex: idx + 1,
    })
    await spoken
    return true
  }

  return {
    matchesIntent(text) {
      return detectDealsCommand(text) || detectProductQuery(text) !== null
    },
    async onDirectCommand(text) {
      const product = detectProductQuery(text)
      if (product) {
        await run(product.keyword, false)
        return { consumed: true }
      }
      if (detectDealsCommand(text)) {
        await run(undefined, true)
        return { consumed: true }
      }
      return undefined
    },
    hasCandidates() { return pending !== null },
    onCandidateSelection: select,
    clearCandidates: clear,
    onSessionReset(reason) {
      if (reason === 'end' || reason === 'start') clear()
    },
  }
}

/** 工厂：源/详情可注入替换（换源不改 skill）；缺省用域内 query + 默认源（含多源降级）。 */
export function createDealsSkill(deps: DealsDeps = {}): SkillModule {
  return {
    id: 'deals',
    name: '商品好价',
    priority: 950, // 守卫类，排在 preference(900) 之后：其它命令都没命中才轮到商品
    description: () => '',
    create: (ctx) => {
      const resolved: DealsDeps = { ...deps }
      if (!resolved.query) {
        const primary = createDealsSource()
        const queryFn = createDealsQuery(ctx.lang, {
          source: primary,
          fallbackSources: createDealsAllSources().filter((s) => s.name !== primary.name),
        })
        resolved.query = async (keyword, dealsOnly) => queryFn({ keyword: keyword ?? undefined, dealsOnly })
      }
      if (!resolved.detail) {
        resolved.detail = (deal) => enrichDeal(createDealsSource(), deal)
      }
      return makeDealsSkill(ctx, resolved)
    },
  }
}

export const dealsSkill: SkillModule = createDealsSkill()
