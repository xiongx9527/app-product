/**
 * MCP 工具动态 token 缓存：App/Agent 通过 `xxx__access_token` 工具换取 token 后，
 * 网关截获结果按 type 缓存；后续同 type 的 `mcp_*` 兼容工具调用时注入 token 参数。
 *
 * 这样 token 由账号本里的账号密码动态换取（每个账号自己的权限），
 * 不依赖中转层连接时注入的静态 token，也无需在中转层配账号。
 */
const cache = new Map<string, string>()

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

/** 会话结束/清空时作废（避免跨会话复用过期 token）。 */
export function clearMcpTokens(): void {
  cache.clear()
}
