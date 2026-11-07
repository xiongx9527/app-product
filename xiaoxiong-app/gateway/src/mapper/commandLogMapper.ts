import { eq, desc } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { commandLogs } from '../db/schema'

/** 命令日志 Mapper。 */
export function commandLogMapper(db: AppDb) {
  return {
    async create(deviceId: string | null, command: string, result: string): Promise<number> {
      const [row] = await db
        .insert(commandLogs)
        .values({ deviceId, command, result })
        .returning({ id: commandLogs.id })
      return row.id
    },
    async listByDevice(deviceId: string | null, limit = 200) {
      if (deviceId) {
        return await db
          .select()
          .from(commandLogs)
          .where(eq(commandLogs.deviceId, deviceId))
          .orderBy(desc(commandLogs.id))
          .limit(limit)
      }
      return await db.select().from(commandLogs).orderBy(desc(commandLogs.id)).limit(limit)
    },
  }
}
