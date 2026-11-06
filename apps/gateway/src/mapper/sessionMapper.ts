import { eq, desc } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { sessions } from '../db/schema'

/** 会话记录 Mapper（类比 MyBatis-Plus 的 Mapper 接口），方法即 SQL 映射。 */
export function sessionMapper(db: AppDb) {
  return {
    async create(deviceId: string | null, startedAt: number): Promise<number> {
      const [row] = await db.insert(sessions).values({ deviceId, startedAt }).returning({ id: sessions.id })
      return row.id
    },
    async end(id: number, endedAt: number): Promise<void> {
      await db.update(sessions).set({ endedAt }).where(eq(sessions.id, id))
    },
    async listByDevice(deviceId: string | null, limit = 100) {
      if (deviceId) {
        return await db
          .select()
          .from(sessions)
          .where(eq(sessions.deviceId, deviceId))
          .orderBy(desc(sessions.id))
          .limit(limit)
      }
      return await db.select().from(sessions).orderBy(desc(sessions.id)).limit(limit)
    },
  }
}
