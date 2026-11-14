import { eq, sql } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { appConfig } from '../db/schema'

/**
 * 设置页「保存配置」的持久化 Mapper（按设备维度，一台设备一份整份配置）。
 * - save：按 device_id 唯一，重复保存覆盖更新（不堆积历史行）。
 * - get：读回该设备最近一次保存的配置 JSON；没有返回 null。
 * 配置内容是前端传来的整份 AppConfig 的 JSON 字符串，网关只负责存取、不解析、不改写。
 */
export function configMapper(db: AppDb) {
  return {
    async save(deviceId: string | null, config: string): Promise<void> {
      await db
        .insert(appConfig)
        .values({ deviceId, config })
        .onConflictDoUpdate({
          target: appConfig.deviceId,
          set: { config, updatedAt: sql`(strftime('%s', 'now'))` },
        })
    },

    async get(deviceId: string | null): Promise<string | null> {
      const rows = deviceId
        ? await db.select().from(appConfig).where(eq(appConfig.deviceId, deviceId))
        : await db.select().from(appConfig)
      return rows[0]?.config ?? null
    },
  }
}
