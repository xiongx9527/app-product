/** 网关运行配置，全部可由环境变量覆盖。 */

/**
 * LLM 能力提供方：stub 为离线测试实现；openai 兼容端点（本地 Ollama 的 /v1 也在内）、
 * dashscope、deepseek 等为真实厂商。
 * ollama 走原生 /api/chat：只有这条路径能拿到模型思考过程（OpenAI 兼容层会丢掉 reasoning）。
 */
export type LlmProviderKind = 'stub' | 'openai' | 'ollama' | 'dashscope' | 'deepseek'
/** ASR 提供方：whisper/azure/aliyun/xunfei 等真实厂商（统一走本地 HTTP baseUrl）；stub 为离线测试实现。 */
export type AsrProviderKind = 'stub' | 'whisper' | 'azure' | 'aliyun' | 'xunfei'
/** TTS 提供方：edge/azure/aliyun/xunfei 等真实厂商（统一走本地 HTTP baseUrl）；stub 为离线测试实现。 */
export type TtsProviderKind = 'stub' | 'edge' | 'azure' | 'aliyun' | 'xunfei'

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
  /** 服务地址（OpenAI 兼容端点；本地 Ollama 通常为 http://host:11434/v1） */
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
  /** 落库加密公钥（RSA 公钥 PEM）：加密 device_data 中的 api-key 等敏感字段 */
  publicKey: string
  /** 落库加密私钥（RSA 私钥 PEM）：解密读取的敏感字段，仅网关侧持有 */
  privateKey: string
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
  /** 各能力对象 */
  ws: WsConfig
  llm: LlmConfig
  asr: AsrConfig
  tts: TtsConfig
  db: DbConfig
}

function oneOf<T extends string>(value: string | undefined, fallback: T): T {
  return (value as T | undefined) ?? fallback
}

/** 环境变量里以 JSON 字符串形式提供厂商级参数，缺省或非法时回退为空对象。 */
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
    port: Number(process.env.PORT ?? 8787),
    apiBase: process.env.API_BASE ?? '/api',
    paramEncrypt: process.env.PARAM_ENCRYPT === 'true',
    rsaBackendPrivateKey: process.env.RSA_BACKEND_PRIVATE_KEY ?? '',
    rsaFrontendPublicKey: process.env.RSA_FRONTEND_PUBLIC_KEY ?? '',
    timeZone: process.env.TIME_ZONE ?? 'Asia/Shanghai',
    ws: { path: process.env.WS_PATH ?? '/ws' },
    llm: {
      provider: oneOf(process.env.LLM_PROVIDER, 'stub'),
      baseUrl: process.env.LLM_BASE_URL ?? 'http://192.168.1.100:11434',
      model: process.env.LLM_MODEL ?? 'gpt-oss:120b-cloud',
      apiKey: process.env.LLM_API_KEY ?? '',
      params: paramsFromEnv('LLM_PARAMS'),
    },
    asr: {
      provider: oneOf(process.env.ASR_PROVIDER, 'stub'),
      baseUrl: process.env.ASR_BASE_URL ?? 'http://192.168.1.100:9529',
      apiKey: process.env.ASR_API_KEY ?? '',
      // 句末静音判定：停顿超过该值才定稿为一轮。默认 2500ms——给自然思考的停顿留足余地，
      // 避免说话中途一停顿（>endpointMs）就被切断、识别成多段（用户反馈"只识别前一段"）。
      // 这也直接决定"助手像失忆"的体感：阈值太短会让一句话被切成几段、只听到前半句。
      // 可用 ASR_ENDPOINT_MS 覆盖（之前 .env 误设为 700，导致一停顿就断）。
      endpointMs: Number(process.env.ASR_ENDPOINT_MS ?? 2500),
      params: paramsFromEnv('ASR_PARAMS'),
    },
    tts: {
      provider: oneOf(process.env.TTS_PROVIDER, 'stub'),
      baseUrl: process.env.TTS_BASE_URL ?? 'http://192.168.1.100:9529',
      apiKey: process.env.TTS_API_KEY ?? '',
      params: paramsFromEnv('TTS_PARAMS'),
    },
    db: {
      path: process.env.DB_PATH ?? './data/app.db',
      publicKey: process.env.DB_PUBLIC_KEY ?? '',
      privateKey: process.env.DB_PRIVATE_KEY ?? '',
    },
  }
}
