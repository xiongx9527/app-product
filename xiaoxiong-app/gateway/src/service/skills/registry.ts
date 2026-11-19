/**
 * Skill 注册表：显式 import 清单。
 *
 * build:bundle 用 esbuild 打成单文件（gateway.bundle.mjs），运行时没有目录结构，
 * 不能扫目录 / import.meta.glob。所以内置 skill 必须在这里显式登记——与
 * tools/index.ts 的 createToolkit 登记工具是同一模式。新增内置 skill：
 *  1) 在 skills/ 下建子目录并实现 SkillModule；
 *  2) 在这里 import 并加进 SKILL_MODULES。
 */
import type { SkillModule } from './types'
import { preferenceSkill } from './preference'

export const SKILL_MODULES: Record<string, SkillModule> = {
  [preferenceSkill.id]: preferenceSkill,
}

/** 按 id 取已登记的 skill；未登记返回 undefined。 */
export function getSkillModule(id: string): SkillModule | undefined {
  return SKILL_MODULES[id]
}
