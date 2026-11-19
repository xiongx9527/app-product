/**
 * Skill 启用加载：网关本地配置文件 GATEWAY_HOME/skills.json 显式控制启用哪些 skill。
 *
 * 配置格式：{ "enabled": ["preference", ...] }
 *  - 文件缺失 / 解析失败 / enabled 为空 → 启用全部已登记 skill（保证现网行为不变，
 *    试点阶段只有 preference，等价于默认开）；
 *  - 有 enabled → 按数组顺序取登记表中的模块，未知 id 打印 warn 跳过。
 *
 * 路径规则仿 asrCorrectionSeed.ts:15-38：优先 GATEWAY_HOME/skills.json，
 * 回退 gateway 源码/打包目录同级（开发与打包都能找到，配置不存在时走默认全开）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SKILL_MODULES } from './registry'
import type { SkillModule } from './types'

const CONFIG_FILE = 'skills.json'

interface SkillsConfig {
  enabled?: string[]
}

function configPath(home: string | undefined): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    ...(home ? [resolve(home, CONFIG_FILE)] : []),
    resolve(here, '../../skills', CONFIG_FILE), // 开发：src/service/skills → gateway/skills
    resolve(here, '../skills', CONFIG_FILE),    // 打包后：dist/ → gateway/skills
  ]
}

function readConfig(): SkillsConfig | null {
  for (const p of configPath(process.env.GATEWAY_HOME)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as SkillsConfig
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 该文件不存在或非法，继续找下一个候选路径
    }
  }
  return null
}

/** 返回本次会话要启用的 skill 模块列表（按配置顺序）。 */
export function loadSkillModules(): SkillModule[] {
  const config = readConfig()
  const enabled = config?.enabled
  if (!Array.isArray(enabled) || enabled.length === 0) {
    // 缺省启用全部已登记模块
    return Object.values(SKILL_MODULES)
  }
  const out: SkillModule[] = []
  for (const id of enabled) {
    const mod = SKILL_MODULES[id]
    if (mod) out.push(mod)
    else console.warn(`[skills] 配置启用了未登记的 skill: ${id}，已跳过`)
  }
  return out
}
