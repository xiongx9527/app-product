export type { TtsProvider } from './provider'
export { StubTts } from './stub'
export { HttpVoiceTts } from './http'
import type { TtsProvider } from './provider'
import { StubTts } from './stub'
import { HttpVoiceTts } from './http'
import type { GatewayConfig } from '../config'

export function createTts(config: GatewayConfig): TtsProvider {
  return config.tts.provider === 'stub'
    ? new StubTts()
    : new HttpVoiceTts(config.tts.baseUrl, config.tts.params, config.tts.apiKey)
}
