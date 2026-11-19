import type { AppDb } from '../db/client'
import { sessionMapper } from '../mapper/sessionMapper'
import { commandLogMapper } from '../mapper/commandLogMapper'
import { memoryMapper, type MemoryEntry } from '../mapper/memoryMapper'
import { configMapper } from '../mapper/configMapper'
import { asrCorrectionMapper, type CorrectionInput } from '../mapper/asrCorrectionMapper'

/**
 * 数据业务层：把各 Mapper 组合成高层能力，供 controller 调用。
 * 这里不写 SQL，SQL 由 Drizzle 基于 schema 生成。
 */
export function createDataService(db: AppDb) {
  const session = sessionMapper(db)
  const command = commandLogMapper(db)
  const memory = memoryMapper(db)
  const config = configMapper(db)
  const asrCorrection = asrCorrectionMapper(db)
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
    listFlatAsrCorrections: asrCorrection.listFlat,
    listMainAsrCorrections: asrCorrection.listMain,
    listAsrVariants: asrCorrection.listVariants,
    findAsrCorrection: asrCorrection.findMain,
    upsertAsrCorrection: asrCorrection.upsertMain,
    upsertAsrVariant: asrCorrection.upsertVariant,
    disableAsrCorrection: asrCorrection.disableMain,
    disableAsrVariant: asrCorrection.disableVariant,
    // 9529 词表同步：待上传（uploaded=0）+ 标记已上传
    listPendingAsrUpload: asrCorrection.listPendingUpload,
    markAsrUploaded: asrCorrection.markUploaded,
  }
}

export type DataService = ReturnType<typeof createDataService>
export type { MemoryEntry, CorrectionInput }

