import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { pinyin } from 'pinyin-pro'
import type { DataService } from './dataService'
import type { CorrectionInput, VariantInput } from '../mapper/asrCorrectionMapper'

/**
 * ASR 纠错词表 seed：启动时把 seed 的两个 JSON 幂等灌入 SQLite。
 *  - asr_corrections.json：主表 [{correct, pinyin, note?}] 热词
 *  - asr_correction_variants.json：字表 [{correct, wrong, pinyin, note?}] 错词（tooltip 用 correct 找主表 id）
 * pinyin 缺失时自动算（无声调）。seed 是权威初始词库，已存在的用 seed 覆盖。
 * 路径：开发从 src/service/ 上两级到 gateway/seed；打包后优先 GATEWAY_HOME/seed/。
 */
function seedPath(home: string | undefined, file: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    ...(home ? [resolve(home, 'seed', file)] : []),
    resolve(here, '../../seed', file), // 开发：src/service/ → gateway/seed
    resolve(here, '../seed', file), // 打包后：dist/ → gateway/seed
    resolve(here, 'seed', file),
  ][0]
}

const py = (w: string) => pinyin(w, { toneType: 'none', type: 'array' }).join(' ')

function readJson<T>(path: string): T[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T[]
  } catch {
    return []
  }
}

export async function seedAsrCorrections(data: DataService): Promise<void> {
  const home = process.env.GATEWAY_HOME
  const mains = readJson<CorrectionInput & { pinyin?: string }>(seedPath(home, 'asr_corrections.json'))
  const variants = readJson<VariantInput & { pinyin?: string }>(seedPath(home, 'asr_correction_variants.json'))

  const idByCorrect = new Map<string, number>()
  for (const m of mains) {
    if (!m.correct) continue
    const id = await data.upsertAsrCorrection({
      correct: m.correct,
      pinyin: m.pinyin || py(m.correct),
      ...(m.note ? { note: m.note } : {}),
    })
    idByCorrect.set(m.correct, id)
  }
  for (const v of variants) {
    if (!v.correct || !v.wrong) continue
    let id = idByCorrect.get(v.correct)
    if (!id) {
      const main = await data.findAsrCorrection(v.correct)
      if (!main) continue
      id = main.id
      idByCorrect.set(v.correct, id)
    }
    await data.upsertAsrVariant(id, {
      wrong: v.wrong,
      pinyin: v.pinyin || py(v.wrong),
      ...(v.note ? { note: v.note } : {}),
    })
  }
}
