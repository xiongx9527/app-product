export type { TtsProvider } from './provider'
export { StubTts } from './stub'
export { HttpVoiceTts } from './http'
export { DashScopeWsTts } from './dashscopeWs'
import type { TtsProvider } from './provider'
import { StubTts } from './stub'
import { HttpVoiceTts } from './http'
import { DashScopeWsTts } from './dashscopeWs'
import type { TtsConfig } from '../config'

export function createTts(cfg: TtsConfig): TtsProvider {
  if (cfg.provider === 'stub') return new StubTts()
  // 百炼等业务空间域名：语音走 /api-ws/v1/inference，与 LLM 的 /compatible-mode/v1 不能混用
  if (cfg.provider === 'dashscope') return new DashScopeWsTts(cfg.baseUrl, cfg.params, cfg.apiKey)
  return new HttpVoiceTts(cfg.baseUrl, cfg.params, cfg.apiKey)
}
