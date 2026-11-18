import { eq, and, sql } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { asrCorrections, asrCorrectionVariants } from '../db/schema'

export interface CorrectionInput {
  correct: string // 正确热词
  pinyin: string // 正确词拼音
  note?: string // 备注/描述（合一）
}

export interface VariantInput {
  correct: string // 所属热词（用于查 id）
  wrong: string // 错词字
  pinyin: string // 错词拼音
  note?: string
}

/** 纠正器加载用的扁平项：错词拼音 → 正确词。 */
export interface FlatCorrection {
  wrong: string
  pinyin: string
  correct: string
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
        })
        .onConflictDoUpdate({
          target: asrCorrections.correct,
          set: {
            pinyin: input.pinyin,
            note: input.note ?? null,
            enabled: 1,
            updatedAt: sql`(strftime('%s', 'now'))`,
          },
        })
      const row = await findMain(input.correct)
      return row!.id
    },

    /** 给某热词加错词（按 correctionId+wrong 唯一）。 */
    async upsertVariant(correctionId: number, v: Omit<VariantInput, 'correct'>): Promise<void> {
      await db
        .insert(asrCorrectionVariants)
        .values({ correctionId, wrong: v.wrong, pinyin: v.pinyin, note: v.note ?? null, enabled: 1 })
        .onConflictDoUpdate({
          target: [asrCorrectionVariants.correctionId, asrCorrectionVariants.wrong],
          set: { pinyin: v.pinyin, note: v.note ?? null, enabled: 1 },
        })
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
