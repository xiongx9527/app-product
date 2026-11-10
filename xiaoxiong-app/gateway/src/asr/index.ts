export type { AsrProvider } from './provider'
export { StubAsr } from './stub'
export { HttpVoiceAsr } from './http'
export { DashScopeWsAsr } from './dashscopeWs'
import type { AsrProvider } from './provider'
import { StubAsr } from './stub'
import { HttpVoiceAsr } from './http'
import { DashScopeWsAsr } from './dashscopeWs'
import type { AsrConfig } from '../config'

export function createAsr(cfg: AsrConfig): AsrProvider {
  if (cfg.provider === 'stub') return new StubAsr()
  // 百炼的实时 ASR 走 WebSocket 入口（api-ws/v1/inference），与 LLM 的 /compatible-mode 不同源
  if (cfg.provider === 'dashscope') return new DashScopeWsAsr(cfg.baseUrl, cfg.params, cfg.apiKey)
  return new HttpVoiceAsr(cfg.baseUrl, cfg.params, cfg.apiKey)
}
