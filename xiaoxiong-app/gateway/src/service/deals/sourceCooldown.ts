/**
 * 好价数据源冷却管理：某源被反爬 / 连续找不到时，冷却一段时间不再用，自动换下一个源。
 *
 * 状态放进程内存（网关进程 lives 期间有效，重启重置即可），不落库——这是运行时健康状态，
 * 不是用户配置。reason 仅用于诊断（nodejs-mobile console 不进 logcat，故经 getSourceCooldowns 暴露）。
 */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000 // 默认冷却 10 分钟

/** 源名 → 冷却到期时间戳（毫秒）。 */
const cooldowns = new Map<string, number>()

/** 该源是否在冷却中。 */
export function isSourceCooling(name: string, now = Date.now()): boolean {
  const until = cooldowns.get(name)
  return typeof until === 'number' && until > now
}

/** 标记源冷却（默认 10 分钟）；重复调用刷新到期时间。 */
export function markSourceCooldown(name: string, ms = DEFAULT_COOLDOWN_MS, now = Date.now()): void {
  cooldowns.set(name, now + ms)
}

/** 源查询成功：清除其冷却，恢复使用。 */
export function clearSourceCooldown(name: string): void {
  cooldowns.delete(name)
}

/** 测试用：清空所有冷却状态。 */
export function resetSourceCooldowns(): void {
  cooldowns.clear()
}

/** 诊断用：导出当前冷却剩余秒数。 */
export function getSourceCooldowns(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, until] of cooldowns) {
    if (until > now) out[name] = Math.round((until - now) / 1000)
  }
  return out
}

/**
 * 识别反爬 / 验证拦截页（命中就应冷却该源）：腾讯云 WAF、百度 seccaptcha、
 * 通用 captcha/verify 挑战页，以及异常短的页面（正常列表页通常 >10KB）。
 */
export function looksAntiBot(html: string): boolean {
  if (!html || html.length < 800) return true
  return /WAF拦截|waf-attack|sec(captcha|check)|captcha|验证页面|probev3|access.*denied|请输入验证码/i.test(
    html.slice(0, 4000)
  )
}
