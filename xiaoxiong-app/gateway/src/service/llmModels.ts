/**
 * 列出某个语音服务来源下「可选择的 LLM 模型」。
 *
 * 模型列表来自该来源的「配置」，不在客户端写死：
 * - 内置（builtin）：读内置语音服务的 /voice/health 里已配置的上游 LLM 模型
 *   （即用户在内置管理服务里加过的模型，如 deepseek-flash / deepseek-v4.1-flash-1017）；
 * - 百炼（dashscope）：走其 OpenAI 兼容 /v1/models（或 /compatible-mode/v1/models），
 *   带用户填的 api-key 拉真实模型目录。
 *
 * 客户端设置页的「LLM 模型」下拉框从这里取选项；用户选中的模型随会话下发，
 * 网关转给来源，来源按模型名路由到对应上游——全程不写死某个具体模型名。
 */

const FETCH_TIMEOUT_MS = 5000

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!res.ok) throw new Error(`上游返回 ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 列出某来源的 LLM 模型：地址优先用客户端设置里带过来的 voice.url（用户真正在用的来源地址，
 * 如自建 MAAS 实例），缺省才回退网关自身配置（VOICE_BUILTIN_URL / VOICE_DASHSCOPE_URL）。
 * 这样「模型列表」和「真实推理」用同一个地址，避免列表从云端拉、推理打到 MAAS 这种
 * 模型名对不上的错位（会导致「模型异常」）。api-key 只落本机，由前端带来，网关透传给来源。
 */
export async function listLlmModels(
  provider: 'builtin' | 'dashscope',
  config: { voiceBuiltinUrl: string; voiceDashscopeUrl: string },
  apiKey?: string,
  url?: string,
): Promise<string[]> {
  if (provider === 'builtin') return listBuiltinModels(url || config.voiceBuiltinUrl, apiKey)
  return listDashScopeModels(url || config.voiceDashscopeUrl, apiKey)
}

/** 内置来源：地址取网关配置 voiceBuiltinUrl，由 Node 网关中转，前端不感知具体地址。
 *  apiKey 非必填——内置服务可匿名访问，但带上来源密钥时（对话要用的那份）需透传。 */
async function listBuiltinModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '')
  if (!base) throw new Error('网关未配置内置语音服务地址（VOICE_BUILTIN_URL）')
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  // 优先用内置服务标准的 OpenAI 兼容 /llm/v1/models（返回 {data:[{id}]}）。
  // 该接口在 LLM 未启用上游时返回 503，此时退回 /voice/health 的已配置上游模型列表。
  try {
    const json = (await fetchJson(`${base}/llm/v1/models`, headers)) as { data?: Array<{ id?: string }> }
    const models = (json?.data ?? []).map((m) => m.id).filter((m): m is string => !!m)
    if (models.length) return Array.from(new Set(models))
  } catch {
    // 走兜底
  }
  const health = (await fetchJson(`${base}/voice/health`, headers)) as {
    upstreams?: { LLM?: Array<{ model?: string }> }
  }
  const upstreams = health?.upstreams?.LLM ?? []
  return Array.from(new Set(upstreams.map((u) => u.model).filter((m): m is string => !!m)))
}

/** 百炼来源：地址取网关配置 voiceDashscopeUrl；api-key 由用户在本机设置，只能从前端带来。 */
async function listDashScopeModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '')
  if (!base) throw new Error('网关未配置 DashScope 地址（VOICE_DASHSCOPE_URL）')
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  // 先试百炼专属 /compatible-mode/v1/models，再退到通用 /v1/models
  for (const path of ['/compatible-mode/v1/models', '/v1/models']) {
    try {
      const json = (await fetchJson(`${base}${path}`, headers)) as { data?: Array<{ id?: string }> }
      const models = (json?.data ?? [])
        .map((m) => m.id)
        .filter((m): m is string => !!m)
      if (models.length) return Array.from(new Set(models))
    } catch {
      // 该路径不通，试下一个
    }
  }
  throw new Error('无法从 DashScope 获取模型列表（检查地址与 api-key 是否正确）')
}
