import type { AppDb } from '../db/client'
import { sessionMapper } from '../mapper/sessionMapper'
import { commandLogMapper } from '../mapper/commandLogMapper'
import { memoryMapper, type MemoryEntry } from '../mapper/memoryMapper'
import { configMapper } from '../mapper/configMapper'

/**
 * 数据业务层：把各 Mapper 组合成高层能力，供 controller 调用。
 * 这里不写 SQL，SQL 由 Drizzle 基于 schema 生成。
 */
export function createDataService(db: AppDb) {
  const session = sessionMapper(db)
  const command = commandLogMapper(db)
  const memory = memoryMapper(db)
  const config = configMapper(db)
  return {
    createSession: session.create,
    endSession: session.end,
    listSessions: session.listByDevice,
    insertCommandLog: command.create,
    listCommandLogs: command.listByDevice,
    saveMemory: memory.save,
    getMemories: memory.list,
    listMemoriesPage: memory.listPage,
    forgetMemory: memory.forget,
    saveAppConfig: config.save,
    getAppConfig: config.get,
  }
}

export type DataService = ReturnType<typeof createDataService>
export type { MemoryEntry }

