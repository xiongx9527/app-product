import type { AppDb } from '../db/client'
import { loadConfig, type GatewayConfig } from '../config'
import { sessionMapper } from '../mapper/sessionMapper'
import { deviceDataMapper } from '../mapper/deviceDataMapper'
import { commandLogMapper } from '../mapper/commandLogMapper'
import { memoryMapper, type MemoryEntry } from '../mapper/memoryMapper'
import { defaultVoiceConfig, normalizeVoiceConfig, type VoiceConfig } from '../voiceConfig'

/**
 * 数据业务层：把各 Mapper 组合成高层能力，供 controller 调用。
 * 这里不写 SQL，SQL 由 Drizzle 基于 schema 生成。
 */
export function createDataService(
  db: AppDb,
  dbPublicKey: string,
  dbPrivateKey: string,
  config: GatewayConfig = loadConfig()
) {
  const session = sessionMapper(db)
  const device = deviceDataMapper(db, dbPublicKey, dbPrivateKey)
  const command = commandLogMapper(db)
  const memory = memoryMapper(db)
  return {
    createSession: session.create,
    endSession: session.end,
    listSessions: session.listByDevice,
    insertDeviceData: device.create,
    listDeviceData: device.listByDevice,
    insertCommandLog: command.create,
    listCommandLogs: command.listByDevice,
    saveMemory: memory.save,
    getMemories: memory.list,
    forgetMemory: memory.forget,
    /** 持久化设备语音服务配置（provider/url/apiKey）到 SQLite，apiKey 随 payload 加密落库 */
    saveVoiceConfig: (deviceId: string | null, voice: VoiceConfig): Promise<number> =>
      device.create(deviceId, 'voice-config', JSON.stringify(voice)),
    /** 读取设备最近一次保存的语音服务配置；无记录时回退默认（内置 / 本地 9529 / 无密钥） */
    getVoiceConfig: async (deviceId: string | null): Promise<VoiceConfig> => {
      if (!deviceId) return defaultVoiceConfig(config.voiceBuiltinUrl)
      const rows = await device.listByDevice(deviceId)
      const row = rows.find((r) => r.type === 'voice-config')
      if (!row) return defaultVoiceConfig(config.voiceBuiltinUrl)
      try {
        return normalizeVoiceConfig(JSON.parse(row.payload))
      } catch {
        return defaultVoiceConfig(config.voiceBuiltinUrl)
      }
    },
  }
}

export type DataService = ReturnType<typeof createDataService>
export type { MemoryEntry }

