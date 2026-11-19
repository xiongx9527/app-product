/**
 * ASR 纠错词表同步：客户端**只下载、不上传**。
 *
 * 词表由 9529 管理端维护（手动添加 → 审核通过 → 下发）。本网关启动时 + 低频定时
 * 从 9529 增量拉取已启用的纠错词，合并进本地词表并刷新内存纠错器。
 * 客户端本地学习的词不会上传（按需求不支持上传）。
 *
 * 水位 lastPullAt 存内存：进程重启后从 0 拉全量（9529 幂等 upsert，安全）。
 */
import { appendFileSync } from 'node:fs'
import type { DataService } from './dataService'
import { loadAsrCorrections } from './voiceSessionService'
import { toPinyin } from './asr/asrCorrector'
import { createAutoLearnEngine, longestSharedSubstring, normalizePronunciation, isProperNounTarget, type AutoLearnContext, type AutoLearnEngine, type AutoLearnRule } from './autoLearn'

/** 与 voiceSessionService 的 bargeDiag 同款落盘：记录自动学习命中及来源。 */
function autoLearnDiag(line: string): void {
  try {
    const home = process.env.GATEWAY_HOME ?? '.'
    appendFileSync(`${home}/barge-diag.log`, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 写失败不影响主流程 */ }
}

const PULL_INTERVAL_MS = 30 * 60 * 1000 // 低频兜底轮询，30 分钟（审核是人工操作）

export interface CorrectionSyncer {
  /** 通用自动学习引擎：agent/工具层只依赖这个抽象，不关心同步/存储等内部细节。 */
  engine: AutoLearnEngine
  /** 从 9529 增量拉取 + 刷新纠错器。启动/定时调用。 */
  sync: () => Promise<void>
  /** 本地存一条纠错词（learn_correction 用）：本地立即生效，不上传。 */
  learn: (correct: string, correctPinyin: string, wrong: string, wrongPinyin: string) => Promise<boolean>
  /** 通用自动学习入口：给定"系统以为的词 from"与"实际正确的词 to"及上下文，
   *  交给规则链判断该如何学。同音纠错是已注册的第一条规则，其它业务可再注册。 */
  autoLearn: (from: string, to: string, ctx?: AutoLearnContext) => Promise<boolean>
  /** 从两段文本各提取中文词做同音比对学习（工具入参/返回、LLM 识别原文/回复共用）。 */
  learnFromTexts: (wrongText: string, correctText: string, ctx?: AutoLearnContext) => Promise<boolean>
  /** 从识别原文取用户词、回答/返回里按锚点取规范词再学（工具/LLM 共用，比文本切片准）。 */
  learnFromAnchors: (fromText: string, toText: string, ctx?: AutoLearnContext) => Promise<boolean>
  /** 注册一条自动学习规则（供将来其它业务扩展，无需改调用方）。 */
  registerRule: (rule: AutoLearnRule) => void
  stop: () => void
}

interface RemoteCorrection {
  main_id: number
  variant_id: number
  wrong: string
  pinyin: string
  correct: string
  updated_at: number
}

export function createCorrectionSyncer(
  data: DataService,
  voiceBuiltinUrl: string,
): CorrectionSyncer {
  const base = voiceBuiltinUrl.replace(/\/$/, '')
  const correctionsUrl = `${base}/voice/v1/corrections`
  let lastPullAt = 0

  // 通用自动学习引擎 + 第一条规则：同音纠错。
  // 其它业务将来只需 engine.register(新规则)，不用改工具/LLM/识别层调用方。
  const engine = createAutoLearnEngine((from, to, ctx, rule) => {
    autoLearnDiag(`AUTO-LEARN source=${ctx.source ?? '?'} rule=${rule} "${from}" → "${to}"`)
  })
  engine.register({
    name: 'homophone-correction',
    async handle(from, to) {
      const w = (from ?? '').trim()
      const c = (to ?? '').trim()
      if (!w || !c || w === c) return false
      // 数据源返回的规范词可能带后缀/书名号（如"李存勖 - 百度百科"），剥掉再比
      const clean = (s: string) => s.replace(/[《》\s]/g, '').replace(/-?\s*百度百科\s*$/, '').trim()
      const wc = clean(w), cc = clean(c)
      if (!wc || !cc || wc === cc) return false
      // 只认纯中文：英文名/带数字的歌名等不学，避免污染词表
      if (!/^[\u4e00-\u9fff]+$/.test(wc) || !/^[\u4e00-\u9fff]+$/.test(cc)) return false
      // from/to 字数必须一样（用户 2026-11-19 规则）：字数不同不是同音纠错，是删字/加字
      if (wc.length !== cc.length) return false
      // 发音归一化后同音才学。归一化规则表见 autoLearn.ts 的 PRON_NORMALIZERS，
      // 平翘舌等混淆可继续往表里加，不用改这里。
      const wp = toPinyin(wc), cp = toPinyin(cc)
      if (!wp || !cp || normalizePronunciation(wp) !== normalizePronunciation(cp)) return false
      // 公共子串≥2：同音但字面毫无关联的两个词不学（挡"神父→神赋"这种只有"神"1字的子串误学）
      if (longestSharedSubstring(wc, cc) < 2) return false
      // 正确词和错词都必须是专有名词形态（人名/地名/作品名/诗词名/歌名/品牌），
      // 不能是动宾/形容词短语（用户 2026-11-19 规则）：
      // 挡「乒乓球→乒乓球好」（正确词带形容词尾巴）、「打乒乓→乒乓球」（错词是动词短语，
      // 纠了会吃掉「打」字破坏原意）。真正的同音错字两边都是名词（李存序→李存勖）。
      if (!isProperNounTarget(cc) || !isProperNounTarget(wc)) return false
      return syncer.learn(cc, cp, wc, wp)
    },
  })
  // 第二条规则：数据源纠错（诗词/百科直连，或工具返回里带明确锚点的规范词）。
  // 数据源把识别词纠成规范词，其返回结果是可信信号。
  // 护栏（2026-11-19 收紧）：direct 或 tool/llm+anchored；纯中文、长度 2–6、
  // from/to 字数必须相等、有≥2字公共子串，且正确词是专有名词（人名/地名/作品/诗词/歌名/品牌）。
  // 字数不等（如旧例"贝洛神父"→"洛神赋"删了字）不再学——用户要求字数一致才纠。
  engine.register({
    name: 'source-correction',
    async handle(from, to, ctx) {
      if (ctx.source !== 'direct' && !(ctx.anchored && (ctx.source === 'tool' || ctx.source === 'llm'))) return false
      const clean = (s: string) => s.replace(/[《》\s]/g, '').replace(/-?\s*百度百科\s*$/, '').trim()
      const wc = clean((from ?? '').trim()), cc = clean((to ?? '').trim())
      if (!wc || !cc || wc === cc) return false
      if (!/^[\u4e00-\u9fff]+$/.test(wc) || !/^[\u4e00-\u9fff]+$/.test(cc)) return false
      if (wc.length < 2 || wc.length > 6 || cc.length < 2 || cc.length > 6) return false
      // from/to 字数必须一样（用户 2026-11-19 规则）：字数不同不是同音纠错，不学
      if (wc.length !== cc.length) return false
      // 公共子串≥2字：确认是同一个词的不同写法，不是两个无关词
      if (longestSharedSubstring(wc, cc) < 2) return false
      // 正确词和错词都必须是专有名词形态（挡「打乒乓→乒乓球」把动词短语纠成名词、
      // 「我喜乒乓→乒乓球好」这种污染词表的垃圾学习；真同音错字两边都是名词）
      if (!isProperNounTarget(cc) || !isProperNounTarget(wc)) return false
      return syncer.learn(cc, toPinyin(cc), wc, toPinyin(wc))
    },
  })
  let timer: ReturnType<typeof setInterval> | null = null
  let syncing = false

  async function refresh(): Promise<void> {
    loadAsrCorrections(await data.listFlatAsrCorrections())
  }

  /** 从 9529 增量拉取并合并进本地。返回是否成功。 */
  async function pull(): Promise<boolean> {
    try {
      const res = await fetch(`${correctionsUrl}?since=${lastPullAt}`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return false
      const body = (await res.json()) as {
        corrections?: RemoteCorrection[]
        max_updated_at?: number
      }
      const rows = body.corrections ?? []
      for (const r of rows) {
        if (!r.correct || !r.wrong) continue
        const mainId = await data.upsertAsrCorrection({
          correct: r.correct,
          pinyin: '', // 主表拼音仅作信息，匹配用变体 wrong 的拼音
          source: 'synced',
          uploaded: 1,
          sourceId: r.main_id,
        })
        await data.upsertAsrVariant(mainId, {
          wrong: r.wrong,
          pinyin: r.pinyin,
          source: 'synced', // 从 9529 拉回
          uploaded: 1,
          sourceId: r.variant_id,
          sourceCorrectionId: r.main_id,
        })
      }
      if (typeof body.max_updated_at === 'number' && body.max_updated_at > lastPullAt) {
        lastPullAt = body.max_updated_at
      }
      return true
    } catch {
      return false // 9529 不可达：静默，下次再拉，本地词表照常用
    }
  }

  async function sync(): Promise<void> {
    if (syncing) return
    syncing = true
    try {
      const pulled = await pull()
      if (pulled) await refresh()
    } finally {
      syncing = false
    }
  }

  const syncer: CorrectionSyncer = {
    engine,
    sync,
    async learn(correct, correctPinyin, wrong, wrongPinyin) {
      // 本地先存（source=local）→ 立即刷新纠错器生效；不上传 9529
      try {
        const mainId = await data.upsertAsrCorrection({
          correct, pinyin: correctPinyin, note: 'learn_correction',
        })
        await data.upsertAsrVariant(mainId, {
          wrong, pinyin: wrongPinyin, source: 'local',
        })
        await refresh()
        return true
      } catch {
        return false
      }
    },
    autoLearn(from, to, ctx) {
      return engine.learn(from, to, ctx)
    },
    learnFromTexts(wrongText, correctText, ctx) {
      return engine.learnFromTexts(wrongText, correctText, ctx)
    },
    learnFromAnchors(fromText, toText, ctx) {
      return engine.learnFromAnchors(fromText, toText, ctx)
    },
    registerRule(rule) {
      engine.register(rule)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }

  // 启动后拉一次，之后低频轮询
  void sync()
  timer = setInterval(() => void sync(), PULL_INTERVAL_MS)
  return syncer
}
