export type { AsrProvider } from './provider'
export { StubAsr } from './stub'
export { HttpVoiceAsr } from './http'
import type { AsrProvider } from './provider'
import { StubAsr } from './stub'
import { HttpVoiceAsr } from './http'
import type { GatewayConfig } from '../config'

export function createAsr(config: GatewayConfig): AsrProvider {
  return config.asr.provider === 'stub'
    ? new StubAsr()
    : new HttpVoiceAsr(config.asr.baseUrl, config.asr.params, config.asr.apiKey)
}
