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

/**
 * 全部已登记 skill，按 priority 升序（数字越小越先匹配）。
 * 网关的直连意图调度按这个顺序遍历，先识别者先消费——顺序由各 skill 自己声明，
 * 新增/调整优先级不用改编排层。配置 enabled 只决定开关，不改变这里的顺序。
 */
export const SKILL_MODULES_BY_PRIORITY: SkillModule[] = Object.values(SKILL_MODULES)
  .slice()
  .sort((a, b) => a.priority - b.priority)
