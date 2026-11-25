/**
 * MCP 工具目录：抓取「网关固定对接的那个 MCP server」对外提供的工具清单，
 * 供 App 设置页「查看已注册工具」展示。
 *
 * 数据源与 App 下发的固定 server 完全一致：地址 = 服务根地址 + /mcp/（Streamable HTTP），
 * 鉴权头与后端一致（VOICE_API_KEY_AUTH 开启时 Bearer API-Key）。
 * 走 Streamable HTTP 单端点：POST initialize 拿 mcp-session-id → POST tools/list。
 * 响应可能是 SSE（text/event-stream），需从 `data:` 行解析 JSON-RPC。
 */

/** 工具参数说明（从 inputSchema 的 properties 提取）。 */
export interface McpToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

export interface McpToolInfo {
  name: string
  description: string
  params: McpToolParam[]
}

/** 把 JSON Schema 的 properties 转成简洁参数列表（只取类型/说明，不回传整个 schema）。 */
function extractParams(schema: unknown): McpToolParam[] {
  const s = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | null
  const required = new Set(s?.required ?? [])
  return Object.entries(s?.properties ?? {}).map(([name, def]) => ({
    name,
    type: typeof def?.type === 'string' ? def.type : 'any',
    description: (def?.description ?? '').trim(),
    required: required.has(name),
  }))
}

/** 从 JSON-RPC 响应体（可能是 SSE 的 data: 行）里取 id 对应的 result。 */
function parseRpcResult(body: string, id: number): unknown | null {
  // SSE：每行 `data: {...}`
  for (const line of body.split('\n')) {
    const text = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
    if (!text.startsWith('{')) continue
    try {
      const msg = JSON.parse(text) as { id?: number; result?: unknown }
      if (msg.id === id) return msg.result ?? null
    } catch { /* 非 JSON 行忽略 */ }
  }
  return null
}

/**
 * 抓 MCP 工具列表。失败返回空数组 + 错误说明，不抛给 HTTP 层（由调用方决定如何提示）。
 * @param baseUrl 服务根地址（如 https://25946kt718.goho.co）
 * @param apiKey 可选 API-Key（Bearer）
 */
export async function fetchMcpTools(baseUrl: string, apiKey?: string): Promise<{ tools: McpToolInfo[]; error?: string }> {
  const root = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!root) return { tools: [], error: '未配置服务地址' }
  const endpoint = `${root}/mcp/`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  try {
    const initRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'app-mcp-catalog', version: '1' } },
      }),
      signal: AbortSignal.timeout(6000),
    })
    if (!initRes.ok) return { tools: [], error: `MCP 握手失败 HTTP ${initRes.status}` }
    const sessionId = initRes.headers.get('mcp-session-id')
    const initBody = await initRes.text()
    if (!parseRpcResult(initBody, 1)) return { tools: [], error: 'MCP 握手响应异常' }
    if (!sessionId) return { tools: [], error: 'MCP 握手缺少 session-id' }

    const listRes = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(6000),
    })
    if (!listRes.ok) return { tools: [], error: `tools/list 失败 HTTP ${listRes.status}` }
    const result = parseRpcResult(await listRes.text(), 2) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
    } | null
    const tools = (result?.tools ?? [])
      .filter((t): t is { name: string; description?: string; inputSchema?: unknown } => typeof t.name === 'string' && !!t.name)
      .map((t) => ({
        name: t.name,
        description: (t.description ?? '').trim(),
        params: extractParams(t.inputSchema),
      }))
    return { tools }
  } catch (e) {
    return { tools: [], error: `MCP 不可用：${(e as Error).message}` }
  }
}
