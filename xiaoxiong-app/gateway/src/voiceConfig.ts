/**
 * 设备语音服务配置（来自客户端 session.start.voice）：
 * 客户端本机的 ASR / LLM / TTS 共用一份来源选择，连同地址、密钥与能力参数（模型 / 静音阈值 / 厂商参数）
 * 一起下发。网关据此展开成每次会话的三套能力配置。
 *
 * 所有字段缺省时回退到网关 config.ts 的代码默认值；但优先采用客户端「设置」里的取值，
 * 即「配置一律来自设置，不写死在网关」。两个默认根地址（内置 / DashScope）也由 config.ts 提供，
 * url 缺省时回退到它。
 */
/** 阿里云百炼（DashScope）官方固定公网入口：语音（ASR/TTS）只能走它。长期稳定不变，
 * 即便用户把 voice.url 换成自建 MAAS 实例，语音仍固定打云端——MAAS 是 LLM-only，无语音入口。 */
const DASHSCOPE_CLOUD_URL = 'https://dashscope.aliyuncs.com'

export type VoiceProviderKind = 'builtin' | 'dashscope'

export interface VoiceConfig {
  provider: VoiceProviderKind
  /** 服务根地址；内置默认 http://127.0.0.1:9529，DashScope 默认 https://dashscope.aliyuncs.com */
  url: string
  /** 内置通常为空；DashScope 必填 */
  apiKey: string
  /** LLM 模型名（如 gemma4:31b-cloud）；缺省回退网关默认 */
  model?: string
  /** ASR 句末静音判定（毫秒）：停顿超过该值才定稿为一轮；缺省回退网关默认 */
  endpointMs?: number
  /** 厂商级参数（language / sampleRate / voice / speed 等），合并进各能力请求；缺省回退网关默认 */
  params?: VendorParams
}

import type { AsrConfig, LlmConfig, TtsConfig, GatewayConfig, VendorParams } from './config'

/** 网关实际使用的三套能力配置（地址/provider 由 voice 决定，能力参数优先取 voice、缺省回退网关） */
export interface ResolvedCapabilities {
  llm: LlmConfig
  asr: AsrConfig
  tts: TtsConfig
}

/** 把任意输入收敛成合法的 VoiceConfig：provider 只接受 builtin / dashscope，其余落回内置 */
export function normalizeVoiceConfig(raw: unknown): VoiceConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const provider: VoiceProviderKind =
    obj.provider === 'dashscope' || obj.provider === 'builtin'
      ? (obj.provider as VoiceProviderKind)
      : 'builtin'
  const url = typeof obj.url === 'string' ? obj.url.trim() : ''
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''
  const model = typeof obj.model === 'string' ? obj.model : undefined
  const endpointMs = typeof obj.endpointMs === 'number' ? obj.endpointMs : undefined
  const params = (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params))
    ? (obj.params as VendorParams)
    : undefined
  return { provider, url, apiKey, model, endpointMs, params }
}

/**
 * 把客户端设置的语音服务配置展开为网关实际使用的三套能力配置。
 * 地址与 provider 由 voice 决定；model / endpointMs / params 优先取 voice，缺省回退网关默认值。
 * url 缺省时回退到 config 里内置 / DashScope 的默认根地址。
 *
 * - builtin：LLM 走 `${root}/llm/v1`（OpenAI 兼容），ASR/TTS 走 `${root}/voice`。
 * - dashscope：LLM 走 `${root}/compatible-mode/v1`；ASR/TTS 的 baseUrl 只给根地址，
 *   由 DashScopeWsAsr/Tts 换算成 wss(s)://host/api-ws/v1/inference（语音与 LLM 路径分家）。
 */
export function resolveCapabilityConfig(
  voice: VoiceConfig | undefined,
  config: GatewayConfig
): ResolvedCapabilities {
  const v = normalizeVoiceConfig(voice)
  // 各能力 provider 默认跟随 voice 的来源（内置 / DashScope）；但网关配置为 stub 时保留 stub
  // （离线测试专用，不联网），这样无真实 LLM/ASR/TTS 也能跑通语音流。
  const llmProvider = config.llm.provider === 'stub' ? 'stub' : v.provider
  const asrProvider = config.asr.provider === 'stub' ? 'stub' : v.provider
  const ttsProvider = config.tts.provider === 'stub' ? 'stub' : v.provider
  if (v.provider === 'dashscope') {
    // 语音（ASR/TTS）只能走阿里云百炼官方云端入口：用户填的 voice.url 可能是自建 MAAS
    // 实例（仅 LLM、无语音入口），若语音也跟着走 MAAS 会 418 失败，故语音固定打云端
    // （DASHSCOPE_CLOUD_URL 长期稳定；环境变量 VOICE_DASHSCOPE_URL 可覆盖）。
    const voiceRoot = config.voiceDashscopeUrl || DASHSCOPE_CLOUD_URL
    // LLM 走用户填的 voice.url（如自建 MAAS 实例）的 /compatible-mode/v1；未填时回退云端。
    const llmRoot = v.url.trim() || config.voiceDashscopeUrl || DASHSCOPE_CLOUD_URL
    return {
      // LLM 走 OpenAI 兼容层 /compatible-mode/v1；语音（ASR/TTS）是百炼的另一套入口，
      // 不在 /compatible-mode 下：网关把云端根地址交给 DashScopeWsAsr/Tts，由它们换算成
      // wss(s)://host/api-ws/v1/inference（实时 ASR / TTS 均走此 WebSocket 入口）。
      llm: { provider: llmProvider, baseUrl: `${llmRoot}/compatible-mode/v1`, model: v.model ?? config.llm.model, apiKey: v.apiKey, params: v.params ?? config.llm.params },
      asr: { provider: asrProvider, baseUrl: voiceRoot, apiKey: v.apiKey, endpointMs: v.endpointMs ?? config.asr.endpointMs, params: v.params ?? config.asr.params },
      tts: { provider: ttsProvider, baseUrl: voiceRoot, apiKey: v.apiKey, params: v.params ?? config.tts.params },
    }
  }
  // builtin（默认）：本地 AI 服务 OpenAI 兼容层，LLM 在 /llm/v1，语音在 /voice。
  const root = v.url.trim() || config.voiceBuiltinUrl
  return {
    llm: { provider: llmProvider, baseUrl: `${root}/llm/v1`, model: v.model ?? config.llm.model, apiKey: v.apiKey, params: v.params ?? config.llm.params },
    asr: { provider: asrProvider, baseUrl: `${root}/voice`, apiKey: v.apiKey, endpointMs: v.endpointMs ?? config.asr.endpointMs, params: v.params ?? config.asr.params },
    tts: { provider: ttsProvider, baseUrl: `${root}/voice`, apiKey: v.apiKey, params: v.params ?? config.tts.params },
  }
}

