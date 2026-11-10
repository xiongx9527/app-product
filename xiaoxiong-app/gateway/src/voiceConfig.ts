/**
 * 设备语音服务配置（来自客户端 session.start.voice / /api/assistant/voice-config）：
 * 客户端本机的 ASR / LLM / TTS 共用一份来源选择。网关据此生成每次会话的临时配置，
 * 并存 SQLite 以在重连/重唤醒时恢复上一次选择。
 *
 * 两个默认根地址（内置 / DashScope）不放这里写死，统一由网关 config.ts 经环境变量注入，
 * 避免代码里出现写死的字面量；这里只做类型与归一化。
 */
export type VoiceProviderKind = 'builtin' | 'dashscope'

export interface VoiceConfig {
  provider: VoiceProviderKind
  /** 服务根地址；内置默认 http://127.0.0.1:9529，DashScope 默认 https://dashscope.aliyuncs.com */
  url: string
  /** 内置通常为空；DashScope 必填 */
  apiKey: string
}

/** 缺省语音配置：内置、本地 9529、无密钥；内置根地址由调用方从 config 注入（不在此写死） */
export function defaultVoiceConfig(builtinUrl: string): VoiceConfig {
  return { provider: 'builtin', url: builtinUrl, apiKey: '' }
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
  return { provider, url, apiKey }
}
