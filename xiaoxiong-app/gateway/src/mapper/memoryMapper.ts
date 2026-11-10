import { eq, desc, like, or, and, sql } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { userMemory } from '../db/schema'

/** 一条记忆：话题标签 + 具体内容 + 创建/更新时间（秒级时间戳）。 */
export interface MemoryEntry {
  key: string
  value: string
  createdAt: number
  updatedAt: number
}

/**
 * 用户长期记忆 Mapper（按设备维度）。
 * - save：按 (device_id, key) 唯一，重复写同一 key 覆盖更新（去重/更新，不重复堆积）。
 * - list：返回该设备全部记忆，按最近更新倒序（最新的在前）。
 * - forget：按话题/内容模糊匹配删除；key 为空表示清空该设备全部记忆。
 */
export function memoryMapper(db: AppDb) {
  // 归一化 key：去首尾空白、压缩中间空白，避免「作息」与「 作息 」被当成两条。
  const normalizeKey = (key: string): string => key.replace(/\s+/g, ' ').trim()

  return {
    async save(deviceId: string | null, key: string, value: string): Promise<void> {
      const k = normalizeKey(key)
      const v = value.replace(/\s+/g, ' ').trim()
      await db
        .insert(userMemory)
        .values({ deviceId, key: k, value: v })
        .onConflictDoUpdate({
          target: [userMemory.deviceId, userMemory.key],
          set: { value: v, updatedAt: sql`(strftime('%s', 'now'))` },
        })
    },

    async list(deviceId: string | null): Promise<MemoryEntry[]> {
      const rows = deviceId
        ? await db
            .select()
            .from(userMemory)
            .where(eq(userMemory.deviceId, deviceId))
            .orderBy(desc(userMemory.updatedAt))
        : await db.select().from(userMemory).orderBy(desc(userMemory.updatedAt))
      return rows.map((r) => ({ key: r.key, value: r.value, createdAt: r.createdAt ?? r.updatedAt ?? 0, updatedAt: r.updatedAt ?? 0 }))
    },

    /**
     * 分页列表（设置页长期记忆用）。与 list 不同：list 用于注入系统提示（要全量），
     * 这里按页返回并带总数，避免记忆很多时一次性拉全。page 从 1 起，pageSize 由调用方限定上限。
     */
    async listPage(
      deviceId: string | null,
      page: number,
      pageSize: number,
      q?: string,
    ): Promise<{ items: MemoryEntry[]; total: number }> {
      const kw = (q ?? '').trim()
      // 关键词检索：在 key / value 中模糊匹配（与 forget 的匹配口径一致）。
      const kwCond = kw
        ? or(like(userMemory.key, `%${kw}%`), like(userMemory.value, `%${kw}%`))
        : undefined
      const where = deviceId
        ? kwCond
          ? and(eq(userMemory.deviceId, deviceId), kwCond)
          : eq(userMemory.deviceId, deviceId)
        : kwCond
      const countRows = await db
        .select({ c: sql<number>`count(*)` })
        .from(userMemory)
        .where(where)
      const total = Number(countRows[0]?.c ?? 0)
      const rows = await db
        .select()
        .from(userMemory)
        .where(where)
        .orderBy(desc(userMemory.updatedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
      return {
        items: rows.map((r) => ({ key: r.key, value: r.value, createdAt: r.createdAt ?? r.updatedAt ?? 0, updatedAt: r.updatedAt ?? 0 })),
        total,
      }
    },

    /**
     * 删除记忆。query 为空字符串 → 清空该设备全部记忆（返回删除条数）。
     * 否则按「key 等于 / key 包含 / value 包含」做模糊匹配，方便语音「忘了XX」命中。
     */
    async forget(deviceId: string | null, query?: string): Promise<number> {
      const q = (query ?? '').replace(/\s+/g, ' ').trim()
      if (!q) {
        const res = deviceId
          ? await db.delete(userMemory).where(eq(userMemory.deviceId, deviceId)).returning({ id: userMemory.id })
          : await db.delete(userMemory).returning({ id: userMemory.id })
        return res.length
      }
      const condition = or(
        eq(userMemory.key, q),
        like(userMemory.key, `%${q}%`),
        like(userMemory.value, `%${q}%`)
      )
      const res = deviceId
        ? await db.delete(userMemory).where(and(eq(userMemory.deviceId, deviceId), condition)).returning({ id: userMemory.id })
        : await db.delete(userMemory).where(condition).returning({ id: userMemory.id })
      return res.length
    },
  }
}
