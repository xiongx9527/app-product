export type { TtsProvider } from './provider'
export { StubTts } from './stub'
export { HttpVoiceTts } from './http'
import type { TtsProvider } from './provider'
import { StubTts } from './stub'
import { HttpVoiceTts } from './http'
import type { TtsConfig } from '../config'

export function createTts(cfg: TtsConfig): TtsProvider {
  if (cfg.provider === 'stub') return new StubTts()
  return new HttpVoiceTts(cfg.baseUrl, cfg.params, cfg.apiKey, cfg.timeouts)
}
