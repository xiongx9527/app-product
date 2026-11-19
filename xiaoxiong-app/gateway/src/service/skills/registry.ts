/**
 * Skill 注册表门面：实际 SKILL_MODULES 由 registry.generated.ts 提供（构建期扫描 *_skill.ts 生成）。
 *
 * 新增 skill：往 skills/ 丢一个 xxx_skill.ts（导出一个 SkillModule 对象）后重新构建即可，
 * 不用手改这里。运行时启用仍由 GATEWAY_HOME/skills.json 的 enabled 白名单控制（见 loader.ts）。
 */
import { SKILL_MODULES } from './registry.generated'
import type { SkillModule } from './types'

export { SKILL_MODULES } from './registry.generated'

/** 按 id 取已登记的 skill；未登记返回 undefined。 */
export function getSkillModule(id: string): SkillModule | undefined {
  return SKILL_MODULES[id]
}
