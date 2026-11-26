/**
 * MCP 工具动态 token 缓存：App/Agent 通过 `xxx__access_token` 工具换取 token 后，
 * 网关截获结果按 type 缓存；后续同 type 的 `mcp_*` 兼容工具调用时注入 token 参数。
 *
 * 这样 token 由账号本里的账号密码动态换取（每个账号自己的权限），
 * 不依赖中转层连接时注入的静态 token，也无需在中转层配账号。
 */
const cache = new Map<string, string>()
/** 上次验证成功的 token 格式是否带 Bearer 前缀（默认裸，实测 App 场景裸 token 参数可用）。 */
const bearerStyle = new Map<string, boolean>()
/** 连续鉴权失败计数（兜底，避免反复重拿/轮换）：超过上限就跳过重试。 */
const failStreak = new Map<string, number>()
const FAIL_STREAK_MAX = 2

/**
 * 判断工具结果文本是否鉴权失败（App 端 token 策略的触发信号）。
 * - tokenExpired：401/unauthorized → token 失效，重拿 token
 * - tokenFormat：prefix/无效 token → 格式问题，Bearer/裸轮换
 */
export function isTokenExpired(text: string): boolean {
  const low = (text ?? '').toLowerCase()
  return low.includes('401') || low.includes('unauthorized')
}

export function isTokenFormatError(text: string): boolean {
  const low = (text ?? '').toLowerCase()
  return ['未按照指定前缀', '未能读取到有效 token', '无效或过期的 token', '无效或过期',
    'token invalid', 'token expired'].some((m) => low.includes(m))
}

/** 取 token 格式（带 Bearer 或裸）。 */
export function getMcpTokenStyled(type: string): string {
  const t = cache.get(type) ?? ''
  if (!t) return ''
  return bearerStyle.get(type) ? `Bearer ${t}` : t
}

/** 记录验证成功的格式：写回缓存（存裸 token）+ Bearer 标记 + 清零失败计数。 */
export function markTokenSuccess(type: string, styledToken: string): void {
  const raw = styledToken.toLowerCase().startsWith('bearer ') ? styledToken.slice(7).trim() : styledToken.trim()
  if (!raw) return
  cache.set(type, raw)
  bearerStyle.set(type, styledToken.toLowerCase().startsWith('bearer '))
  failStreak.set(type, 0)
}

/** 失败计数 +1，返回是否还能重试（未达上限）。 */
export function bumpFailStreak(type: string): boolean {
  const n = (failStreak.get(type) ?? 0) + 1
  failStreak.set(type, n)
  return n <= FAIL_STREAK_MAX
}

/** 会话结束/清空时作废（避免跨会话复用过期 token）。 */
export function clearMcpTokenState(): void {
  cache.clear()
  bearerStyle.clear()
  failStreak.clear()
}

/** 从 access_token 工具的返回文本里提取 token（兼容 {"token":...} / {"access_token":...} / 裸串）。 */
export function parseToken(text: string): string {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as { token?: string; access_token?: string }
    return (obj.token || obj.access_token || '').trim()
  } catch {
    // 裸 token（UUID / JWT）：无空白且长度合理才算
    return /^[A-Za-z0-9._-]{16,}$/.test(raw) ? raw : ''
  }
}

/** 缓存某 type 的 token。 */
export function setMcpToken(type: string, token: string): void {
  if (type && token) cache.set(type, token)
}

/** 取某 type 缓存的 token。 */
export function getMcpToken(type: string): string {
  return cache.get(type) ?? ''
}
