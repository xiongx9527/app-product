/**
 * 动态增强 MCP 工具描述：让「工具自己」告诉 LLM 凭据怎么用。
 *
 * 不写死任何业务名：对工具名 `xxx__tool` 提取前缀 `xxx`，若同前缀存在 `xxx__access_token` 工具，
 * 就给该前缀下的工具描述补一句「需要该提供商的账号密码，先调 access_token 工具获取 token，
 * 再作为 token 入参传入」。LLM 看工具描述（MCP 的设计）就懂，不污染系统提示词。
 */

interface MutableTool {
  name?: string
  description?: string
  inputSchema?: unknown
}

/** 取工具名前缀（`askdata__mcp_question` → `askdata`）。 */
function prefixOf(name: string): string {
  const i = name.indexOf('__')
  return i > 0 ? name.slice(0, i) : ''
}

/** 工具 schema 是否有 token 入参字段。 */
function hasTokenParam(tool: MutableTool): boolean {
  const s = tool.inputSchema as { properties?: Record<string, unknown> } | undefined
  return !!s?.properties && Object.prototype.hasOwnProperty.call(s.properties, 'token')
}

/**
 * 给 toolkit 里的工具描述补充凭据说明（就地修改 description）。
 * 返回被增强的工具名列表（诊断用）。
 */
export function enhanceToolDescriptions(tools: MutableTool[]): string[] {
  // 按前缀收集：哪些前缀有 access_token 工具、哪些工具有 token 入参
  const prefixesWithTokenTool = new Set<string>()
  for (const t of tools) {
    const p = prefixOf(t.name ?? '')
    if (p && (t.name ?? '').includes('__access_token')) prefixesWithTokenTool.add(p)
  }

  const enhanced: string[] = []
  for (const t of tools) {
    const p = prefixOf(t.name ?? '')
    if (!p || !prefixesWithTokenTool.has(p)) continue
    // access_token 工具本身不增强（它就是拿 token 的）
    if ((t.name ?? '').includes('__access_token')) continue
    if (hasTokenParam(t)) {
      const note = `\n【凭据】调用本工具前，先调用 ${p}__access_token 工具（账号/密码由系统提供，无需你填写）获取 token，并把 token 作为本工具的 token 入参传入。`
      t.description = (t.description ?? '') + note
      enhanced.push(t.name ?? '')
    }
  }
  return enhanced
}
