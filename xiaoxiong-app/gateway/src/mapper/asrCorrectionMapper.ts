import { eq, and, sql, inArray } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { asrCorrections, asrCorrectionVariants } from '../db/schema'

/** 纠错词来源：local=本地学的（待上传 9529）、synced=从 9529 同步的。 */
export type CorrectionSource = 'local' | 'synced'

export interface CorrectionInput {
  correct: string // 正确热词
  pinyin: string // 正确词拼音
  note?: string // 备注/描述（合一）
  source?: CorrectionSource
  uploaded?: number // 上传标识：0=待上传，1=已上传/拉回。缺省 0
  sourceId?: number | null // 9529 侧主表 id
}

export interface VariantInput {
  correct: string // 所属热词（用于查 id）
  wrong: string // 错词字
  pinyin: string // 错词拼音
  note?: string
  source?: CorrectionSource // 缺省 local
  uploaded?: number // 上传标识：0=待上传，1=已上传/拉回。缺省 0
  sourceId?: number | null // 9529 侧变体 id
  sourceCorrectionId?: number | null // 9529 侧主表 id
}

/** 纠正器加载用的扁平项：错词拼音 → 正确词。 */
export interface FlatCorrection {
  wrong: string
  pinyin: string // 错词拼音（匹配用）
  correct: string
  correctPinyin?: string // 正确词拼音（上传 9529 用）
  id?: number // 本地变体 id（标记已上传用）
}

/**
 * ASR 纠错词表 Mapper（两表）：主表热词 + 字表错词。
 * - listFlat：联表返回所有启用的 {wrong, pinyin, correct}，供纠正器加载。
 * - 主表/字表 upsert 与软删除，供 seed 与管理接口维护。
 */
export function asrCorrectionMapper(db: AppDb) {
  async function findMain(correct: string) {
    const rows = await db.select().from(asrCorrections).where(eq(asrCorrections.correct, correct))
    return rows[0] ?? null
  }
  return {
    /** 纠正器加载：联表取启用项。 */
    async listFlat(): Promise<FlatCorrection[]> {
      const rows = await db
        .select({
          wrong: asrCorrectionVariants.wrong,
          wrongPinyin: asrCorrectionVariants.pinyin,
          correct: asrCorrections.correct,
        })
        .from(asrCorrectionVariants)
        .innerJoin(asrCorrections, eq(asrCorrectionVariants.correctionId, asrCorrections.id))
        .where(and(eq(asrCorrectionVariants.enabled, 1), eq(asrCorrections.enabled, 1)))
      return rows.map((r) => ({ wrong: r.wrong, pinyin: r.wrongPinyin, correct: r.correct }))
    },

    /** 主表列出全部（含停用），管理面板用。 */
    async listMain(): Promise<Array<CorrectionInput & { id: number; enabled: number }>> {
      const rows = await db.select().from(asrCorrections)
      return rows.map((r) => ({
        id: r.id,
        correct: r.correct,
        pinyin: r.pinyin,
        enabled: r.enabled,
        ...(r.note ? { note: r.note } : {}),
      }))
    },

    /** 某热词下的错词（含停用）。 */
    async listVariants(correct: string): Promise<Array<VariantInput & { id: number; enabled: number }>> {
      const main = await findMain(correct)
      if (!main) return []
      const rows = await db.select().from(asrCorrectionVariants).where(eq(asrCorrectionVariants.correctionId, main.id))
      return rows.map((r) => ({
        id: r.id, correct, wrong: r.wrong, pinyin: r.pinyin, enabled: r.enabled,
        ...(r.note ? { note: r.note } : {}),
      }))
    },

    async findMain(correct: string) {
      const rows = await db.select().from(asrCorrections).where(eq(asrCorrections.correct, correct))
      return rows[0] ?? null
    },

    /** upsert 主表热词，返回其 id。 */
    async upsertMain(input: CorrectionInput): Promise<number> {
      await db
        .insert(asrCorrections)
        .values({
          correct: input.correct, pinyin: input.pinyin, note: input.note ?? null, enabled: 1,
          source: input.source ?? 'local', uploaded: input.uploaded ?? 0,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        })
        .onConflictDoUpdate({
          target: asrCorrections.correct,
          set: {
            // pinyin 为空时不覆盖（同步拉回时没有正确词拼音，保留本地已有的）
            ...(input.pinyin ? { pinyin: input.pinyin } : {}),
            note: input.note ?? null,
            enabled: 1,
            ...(input.source ? { source: input.source } : {}),
            ...(input.uploaded !== undefined ? { uploaded: input.uploaded } : {}),
            ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
            updatedAt: sql`(strftime('%s', 'now'))`,
          },
        })
      const row = await findMain(input.correct)
      return row!.id
    },

    /** 给某热词加错词（按 correctionId+wrong 唯一）。source=local 表示本地新增待上传。 */
    async upsertVariant(correctionId: number, v: Omit<VariantInput, 'correct'>): Promise<void> {
      await db
        .insert(asrCorrectionVariants)
        .values({
          correctionId, wrong: v.wrong, pinyin: v.pinyin, note: v.note ?? null,
          enabled: 1, source: v.source ?? 'local', uploaded: v.uploaded ?? 0,
          ...(v.sourceId !== undefined ? { sourceId: v.sourceId } : {}),
          ...(v.sourceCorrectionId !== undefined ? { sourceCorrectionId: v.sourceCorrectionId } : {}),
        })
        .onConflictDoUpdate({
          target: [asrCorrectionVariants.correctionId, asrCorrectionVariants.wrong],
          set: {
            pinyin: v.pinyin, note: v.note ?? null, enabled: 1,
            ...(v.source !== undefined ? { source: v.source } : {}),
            ...(v.uploaded !== undefined ? { uploaded: v.uploaded } : {}),
            ...(v.sourceId !== undefined ? { sourceId: v.sourceId } : {}),
            ...(v.sourceCorrectionId !== undefined ? { sourceCorrectionId: v.sourceCorrectionId } : {}),
            updatedAt: sql`(strftime('%s', 'now'))`,
          },
        })
    },

    /** 待上传 9529 的错词（uploaded=0），联表带出正确词和拼音。 */
    async listPendingUpload(): Promise<FlatCorrection[]> {
      const rows = await db
        .select({
          id: asrCorrectionVariants.id,
          wrong: asrCorrectionVariants.wrong,
          wrongPinyin: asrCorrectionVariants.pinyin,
          correct: asrCorrections.correct,
          correctPinyin: asrCorrections.pinyin,
        })
        .from(asrCorrectionVariants)
        .innerJoin(asrCorrections, eq(asrCorrectionVariants.correctionId, asrCorrections.id))
        .where(and(eq(asrCorrectionVariants.enabled, 1), eq(asrCorrectionVariants.uploaded, 0)))
      return rows.map((r) => ({
        id: r.id, wrong: r.wrong, pinyin: r.wrongPinyin,
        correct: r.correct, correctPinyin: r.correctPinyin,
      }))
    },

    /** 标记这些变体已上传（uploaded=1，source 保持 local 不变——来源和上传状态是两个维度）。同时标记对应主表。 */
    async markUploaded(ids: number[]): Promise<void> {
      if (!ids.length) return
      const rows = await db.select().from(asrCorrectionVariants)
        .where(inArray(asrCorrectionVariants.id, ids))
      await db.update(asrCorrectionVariants)
        .set({ uploaded: 1, updatedAt: sql`(strftime('%s', 'now'))` })
        .where(inArray(asrCorrectionVariants.id, ids))
      const mainIds = [...new Set(rows.map((r) => r.correctionId))]
      if (mainIds.length) {
        await db.update(asrCorrections)
          .set({ uploaded: 1 })
          .where(inArray(asrCorrections.id, mainIds))
      }
    },

    /** 回填 9529 来源 id（本地词上传成功后记下对端的 main/variant id）。 */
    async setAsrSourceId(localVariantId: number, sourceMainId: number, sourceVariantId: number): Promise<void> {
      const v = await db.select().from(asrCorrectionVariants)
        .where(eq(asrCorrectionVariants.id, localVariantId)).then((r) => r[0])
      if (!v) return
      await db.update(asrCorrections)
        .set({ sourceId: sourceMainId })
        .where(eq(asrCorrections.id, v.correctionId))
      await db.update(asrCorrectionVariants)
        .set({ sourceId: sourceVariantId, sourceCorrectionId: sourceMainId })
        .where(eq(asrCorrectionVariants.id, localVariantId))
    },

    async disableMain(correct: string): Promise<void> {
      await db.update(asrCorrections).set({ enabled: 0 }).where(eq(asrCorrections.correct, correct))
    },

    async disableVariant(correct: string, wrong: string): Promise<void> {
      const main = await findMain(correct)
      if (!main) return
      await db
        .update(asrCorrectionVariants)
        .set({ enabled: 0 })
        .where(and(eq(asrCorrectionVariants.correctionId, main.id), eq(asrCorrectionVariants.wrong, wrong)))
    },
  }
}
