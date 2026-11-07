import type { AppDb } from '../db/client'
import { sessionMapper } from '../mapper/sessionMapper'
import { deviceDataMapper } from '../mapper/deviceDataMapper'
import { commandLogMapper } from '../mapper/commandLogMapper'

/**
 * 数据业务层：把各 Mapper 组合成高层能力，供 controller 调用。
 * 这里不写 SQL，SQL 由 Drizzle 基于 schema 生成。
 */
export function createDataService(db: AppDb, dbPublicKey: string, dbPrivateKey: string) {
  const session = sessionMapper(db)
  const device = deviceDataMapper(db, dbPublicKey, dbPrivateKey)
  const command = commandLogMapper(db)
  return {
    createSession: session.create,
    endSession: session.end,
    listSessions: session.listByDevice,
    insertDeviceData: device.create,
    listDeviceData: device.listByDevice,
    insertCommandLog: command.create,
    listCommandLogs: command.listByDevice,
  }
}

export type DataService = ReturnType<typeof createDataService>
