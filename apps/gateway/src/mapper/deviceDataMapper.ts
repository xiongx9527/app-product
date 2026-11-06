import { eq, desc } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { deviceData } from '../db/schema'
import { encryptWithPublicKey, decryptWithPrivateKey } from '../crypto'

/** 设备数据 Mapper。type === 'api-key' 的记录其 payload 在落库时加密、读取时解密。 */
export function deviceDataMapper(db: AppDb, dbPublicKey: string, dbPrivateKey: string) {
  const isSecret = (type: string): boolean => type === 'api-key'

  // 解密失败（如历史明文数据）时回退原文，避免整个列表读不出。
  const safeDecrypt = (value: string, type: string): string => {
    if (!isSecret(type)) return value
    try {
      return decryptWithPrivateKey(dbPrivateKey, value)
    } catch {
      return value
    }
  }

  return {
    async create(deviceId: string | null, type: string, payload: string): Promise<number> {
      const stored = isSecret(type) ? encryptWithPublicKey(dbPublicKey, payload) : payload
      const [row] = await db
        .insert(deviceData)
        .values({ deviceId, type, payload: stored })
        .returning({ id: deviceData.id })
      return row.id
    },
    async listByDevice(deviceId: string | null, limit = 200) {
      const rows = deviceId
        ? await db
            .select()
            .from(deviceData)
            .where(eq(deviceData.deviceId, deviceId))
            .orderBy(desc(deviceData.id))
            .limit(limit)
        : await db.select().from(deviceData).orderBy(desc(deviceData.id)).limit(limit)
      return rows.map((r) => ({ ...r, payload: safeDecrypt(r.payload, r.type) }))
    },
  }
}
