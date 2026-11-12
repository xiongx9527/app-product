/** 网关运行配置，全部可由环境变量覆盖。 */

/**
 * 能力提供方：只有「内置」与「DashScope」两种来源，由客户端设置页选择（session.start.voice）。
 * 网关据此决定走哪套传输：内置走本地 AI 服务的 OpenAI 兼容层（/llm/v1、/voice），
 * DashScope 走其 OpenAI 兼容 /compatible-mode 与官方 SDK。stub 仅离线测试用。
 */
export type LlmProviderKind = 'stub' | 'builtin' | 'dashscope'
/** ASR 提供方：内置 / DashScope / stub（离线测试）。 */
export type AsrProviderKind = 'stub' | 'builtin' | 'dashscope'
/** TTS 提供方：内置 / DashScope / stub（离线测试）。 */
export type TtsProviderKind = 'stub' | 'builtin' | 'dashscope'

/** 各能力的厂商级额外参数（key-value 映射），透传给对应服务，例如：
 *  llm: { temperature, top_p, ... }；asr: { language, sampleRate, ... }；tts: { voice, speed, ... }。 */
export type VendorParams = Record<string, unknown>

/** WebSocket 传输配置 */
export interface WsConfig {
  /** 升级路径 */
  path: string
}

/** LLM 能力配置 */
export interface LlmConfig {
  provider: LlmProviderKind
  /** 服务地址；默认指向本地 AI 服务的 /llm（由它再转发 Ollama 或远程代理） */
  baseUrl: string
  /** 模型名 */
  model: string
  /** API Key（本地 LLM 通常为空；切换远端托管厂商时填入） */
  apiKey: string
  /** 厂商级额外参数（如 temperature / top_p），透传给 Ollama 的 options */
  params: VendorParams
}

/** ASR 能力配置 */
export interface AsrConfig {
  provider: AsrProviderKind
  /** 本地 ASR 服务地址（无 API key） */
  baseUrl: string
  /** API Key（本地语音服务通常为空；远端厂商填入） */
  apiKey: string
  /** 静音判定：连续多少毫秒无新音频即认为一句话结束 */
  endpointMs: number
  /** 厂商级额外参数（如 language / sampleRate），透传为请求参数 */
  params: VendorParams
}

/** TTS 能力配置 */
export interface TtsConfig {
  provider: TtsProviderKind
  /** 本地 TTS 服务地址（无 API key） */
  baseUrl: string
  /** API Key（本地语音服务通常为空；远端厂商填入） */
  apiKey: string
  /** 厂商级额外参数（如 voice / speed / format），合并进请求体 */
  params: VendorParams
}

/** 数据库配置 */
export interface DbConfig {
  /** SQLite 文件路径，:memory: 表示内存库 */
  path: string
}

/** 自动记忆（抽取 + 摘要）相关网关配置 */
export interface MemoryGatewayConfig {
  /** 合并（摘要）触发阈值：记忆条数达到此值后，每隔 consolidateEvery 轮抽取合并去重一次 */
  consolidateThreshold: number
  /** 合并（摘要）频率：每这么多次抽取触发一次合并（避免每次都打 LLM） */
  consolidateEvery: number
}

export interface GatewayConfig {
  /** HTTP / WebSocket 监听端口 */
  port: number
  /** REST 数据接口前缀 */
  apiBase: string
  /** 前后端参数加密开关（REST 请求/响应加解密） */
  paramEncrypt: boolean
  /** 后端 RSA 私钥（PEM）：用于解密前端发来的请求参数 */
  rsaBackendPrivateKey: string
  /** 前端 RSA 公钥（PEM）：用于加密发往前端的响应参数 */
  rsaFrontendPublicKey: string
  /** 时区：时间工具据此返回本地时间，默认东八区（Asia/Shanghai） */
  timeZone: string
  /** 内置语音服务默认根地址（可经 VOICE_BUILTIN_URL 覆盖，例如 LAN 里的本地 AI 服务地址） */
  voiceBuiltinUrl: string
  /** DashScope 默认根地址（可经 VOICE_DASHSCOPE_URL 覆盖，例如业务空间地址） */
  voiceDashscopeUrl: string
  /** 各能力对象 */
  ws: WsConfig
  llm: LlmConfig
  asr: AsrConfig
  tts: TtsConfig
  db: DbConfig
  /** 自动记忆（抽取 + 摘要）：合并/摘要的触发阈值与频率，可经环境变量覆盖 */
  memory: MemoryGatewayConfig
}

function paramsFromEnv(name: string): VendorParams {
  const raw = process.env[name]
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as VendorParams) : {}
  } catch {
    return {}
  }
}

export function loadConfig(): GatewayConfig {
  return {
    // 内嵌模式原生层用 GATEWAY_PORT 指定端口（0=系统分配），向后兼容 PORT 与默认 8787。
    port: Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787),
    apiBase: process.env.API_BASE ?? '/api',
    paramEncrypt: process.env.PARAM_ENCRYPT === 'true',
    rsaBackendPrivateKey: process.env.RSA_BACKEND_PRIVATE_KEY ?? '',
    rsaFrontendPublicKey: process.env.RSA_FRONTEND_PUBLIC_KEY ?? '',
    timeZone: process.env.TIME_ZONE ?? 'Asia/Shanghai',
    // 内置 / DashScope 的默认根地址：仅作兜底（客户端未带 url 时用），由部署环境变量决定。
    voiceBuiltinUrl: process.env.VOICE_BUILTIN_URL ?? '',
    voiceDashscopeUrl: process.env.VOICE_DASHSCOPE_URL ?? '',
    ws: { path: process.env.WS_PATH ?? '/ws' },
    // 以下 provider / baseUrl 仅为类型占位，真实值由客户端设置（session.start.voice）
    // 经 voiceConfig.resolveCapabilityConfig 展开。
    llm: {
      provider: 'builtin',
      baseUrl: '',
      // 默认空：模型名完全来自客户端配置（session.start.voice），网关不预设任何模型。
      model: '',
      // apiKey 来自客户端设置（session.start.voice），不在此读 .env。
      apiKey: '',
      params: paramsFromEnv('LLM_PARAMS'),
    },
    asr: {
      provider: 'builtin',
      baseUrl: '',
      // apiKey 来自客户端设置（session.start.voice），不在此读 .env。
      apiKey: '',
      // 句末静音判定：停顿超过该值才定稿为一轮。默认 2500ms——给自然思考的停顿留足余地，
      // 避免说话中途一停顿（>endpointMs）就被切断、识别成多段（用户反馈"只识别前一段"）。
      // 这也直接决定"助手像失忆"的体感：阈值太短会让一句话被切成几段、只听到前半句。
      // 可用 ASR_ENDPOINT_MS 覆盖（之前 .env 误设为 700，导致一停顿就断）。
      endpointMs: Number(process.env.ASR_ENDPOINT_MS ?? 2500),
      params: paramsFromEnv('ASR_PARAMS'),
    },
    tts: {
      provider: 'builtin',
      baseUrl: '',
      // apiKey 来自客户端设置（session.start.voice），不在此读 .env。
      apiKey: '',
      params: paramsFromEnv('TTS_PARAMS'),
    },
    db: {
      path: process.env.DB_PATH ?? './data/app.db',
    },
    // 自动记忆（抽取 + 摘要）：合并触发阈值与频率，可经环境变量覆盖以便调参，不写死在代码里。
    // MEMORY_CONSOLIDATE_THRESHOLD：记忆条数达到此值才周期性合并；MEMORY_CONSOLIDATE_EVERY：每这么多次抽取合并一次。
    memory: {
      consolidateThreshold: Number(process.env.MEMORY_CONSOLIDATE_THRESHOLD ?? 30),
      consolidateEvery: Number(process.env.MEMORY_CONSOLIDATE_EVERY ?? 5),
    },
  }
}
