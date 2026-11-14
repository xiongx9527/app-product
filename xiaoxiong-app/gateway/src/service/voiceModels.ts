/**
 * 列出某语音服务来源下「可选择的 ASR / TTS 模型」。
 *
 * 与 LLM 模型同理：地址由网关持有并中转，前端只传 provider + capability（asr | tts），
 * 可选带 api-key / url（自建实例）。但 ASR / TTS 没有 LLM 那种统一的 OpenAI 兼容 /v1/models
 * 可枚举目录，因此这里采用「实时目录 + 官方清单兜底」双轨：
 *
 * - 内置（builtin）：实时去本地语音服务（9529）的 /voice/v1/models 拉当前已配置模型
 *   （builtin 固定 sensevoice-small / edge-tts；若 9529 配了上游还会带出上游模型），按 type
 *   拆成 STT / TTS；拉不到或拉空时回退到内置固定清单，保证永远有得选。内置本地服务无需 api-key。
 * - 百炼（dashscope）：DashScope 没有可匿名枚举 ASR / TTS 模型的开放接口（/voice/v1/models
 *   这类目录需要上游密钥、且只列 9529 自身配置的 providers，不属于客户端的百炼来源），因此
 *   直接使用与 9529 管理面板同源的官方权威清单（DASHSCOPE_VOICE_MODELS）作为兜底目录——
 *   这份清单由我们维护、随官方更新，不写死地址，也不发网络请求。这同样满足「两个源永远有得选」。
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

/** 能力端口：前端用 asr / tts，网关内部统一映射成 9529 的 STT / TTS。 */
export type VoiceCapability = 'asr' | 'tts'
type VoiceType = 'STT' | 'TTS'

function capabilityToType(cap: VoiceCapability): VoiceType {
  return cap === 'asr' ? 'STT' : 'TTS'
}

/** 内置来源固定兜底清单：本地引擎恒有的模型，拉不到上游时也保证可选。 */
const BUILTIN_FALLBACK: Record<VoiceType, string[]> = {
  STT: ['sensevoice-small'],
  TTS: ['edge-tts'],
}

/**
 * 百炼官方语音模型清单（与 9529 管理面板 DASHSCOPE_VOICE_MODELS 同源，逐条取自阿里云官方文档，
 * 随官方更新）。DashScope 不提供匿名枚举接口，故作为权威兜底目录写死于此，不依赖网络 / 密钥。
 */
const DASHSCOPE_FALLBACK: Record<VoiceType, string[]> = {
  // 语音识别（STT）：Paraformer / Fun-ASR / Qwen-ASR / Gummy / SenseVoice 各系。
  STT: [
    'paraformer-realtime-v2',
    'paraformer-realtime-v1',
    'paraformer-realtime-8k-v2',
    'paraformer-realtime-8k-v1',
    'paraformer-v2',
    'paraformer-v1',
    'paraformer-8k-v2',
    'paraformer-8k-v1',
    'paraformer-mtl-v1',
    'fun-asr',
    'fun-asr-realtime',
    'fun-asr-realtime-2026-02-28',
    'fun-asr-flash-2026-06-15',
    'fun-asr-flash-8k-realtime',
    'fun-asr-mtl',
    'qwen3-asr-flash',
    'qwen3-asr-flash-realtime',
    'qwen3-asr-flash-filetrans',
    'qwen-audio-3.0-asr-flash',
    'qwen-audio-3.0-asr-flash-streaming',
    'qwen-audio-3.0-asr-flash-filetrans',
    'qwen-audio-3.1-asr-flash',
    'qwen-audio-3.1-asr-flash-streaming',
    'qwen-audio-3.1-asr-flash-filetrans',
    'qwen-audio-3.1-asr-flash-message',
    'gummy-realtime-v1',
    'gummy-chat-v1',
    'sensevoice-v1',
  ],
  // 语音合成（TTS）：CosyVoice 系 + Qwen-TTS 系 + Sambert（HTTP / WS 各协议都列入，协议由面板小字标注）。
  TTS: [
    'qwen3-tts-flash',
    'qwen-tts',
    'qwen-audio-3.0-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'qwen-audio-3.1-tts-flash',
    'qwen-audio-3.1-tts-next',
    'cosyvoice-v3-flash',
    'cosyvoice-v3-plus',
    'cosyvoice-v2',
    'cosyvoice-v1',
  ],
}

function dedupeSorted(models: string[]): string[] {
  return Array.from(new Set(models.filter((m) => !!m))).sort()
}

/**
 * 列出某来源的 ASR / TTS 模型：地址优先用前端带过来的 voice.url（用户真正在用的来源地址，
 * 如自建 9529 实例），缺省回退网关自身配置（VOICE_BUILTIN_URL）。内置本地服务无需 api-key，
 * 但带上来源密钥时（对话要用的那份）仍透传，便于自建实例鉴权。
 */
export async function listVoiceModels(
  provider: 'builtin' | 'dashscope',
  capability: VoiceCapability,
  config: { voiceBuiltinUrl: string; voiceDashscopeUrl: string },
  apiKey?: string,
  url?: string,
): Promise<string[]> {
  const type = capabilityToType(capability)
  if (provider === 'builtin') {
    return listBuiltinVoiceModels(type, url || config.voiceBuiltinUrl, apiKey)
  }
  // 百炼：无匿名枚举接口，直接返回同源官方清单兜底。
  return dedupeSorted(DASHSCOPE_FALLBACK[type])
}

/** 内置来源：实时拉 9529 /voice/v1/models，按 type 拆 STT / TTS，并与固定兜底合并。 */
async function listBuiltinVoiceModels(
  type: VoiceType,
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '')
  const fallback = BUILTIN_FALLBACK[type]
  if (!base) {
    // 网关没配内置地址：直接返回兜底，保证有得选。
    return dedupeSorted(fallback)
  }
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  try {
    const json = (await fetchJson(`${base}/voice/v1/models`, headers)) as {
      data?: Array<{ id?: string; type?: string }>
    }
    const live = (json?.data ?? [])
      .filter((m) => m.type === type)
      .map((m) => m.id)
      .filter((m): m is string => !!m)
    // 实时目录 + 固定兜底合并：兜底保证已知可用模型恒在，实时目录补充上游配置出来的模型。
    return dedupeSorted([...fallback, ...live])
  } catch {
    // 拉不到：回退到内置固定清单，仍保证有得选。
    return dedupeSorted(fallback)
  }
}
