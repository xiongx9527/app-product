import type { MusicConfig, MusicProviderKind, MusicSource } from './types'
import { createSomaSource } from './somaSource'
import { createCustomSource } from './customSource'
import { createNeteaseSource } from './neteaseSource'
import { createQqSource } from './qqSource'
import { createSpotifySource } from './spotifySource'

export type { MusicConfig, MusicProviderKind, MusicSource } from './types'

/**
 * 按客户端上报的音乐配置构造播放源；与 geocode 的 createGeocodeAdapter 同构。
 * 未配置或厂商未知时返回 undefined，调用方据此不注册音乐工具。
 */
export function createMusicSource(config?: MusicConfig): MusicSource | undefined {
  if (!config?.provider) return undefined
  const kind = config.provider as MusicProviderKind
  const params = config.params ?? {}
  switch (kind) {
    case 'soma':
      return createSomaSource(params)
    case 'custom':
      return createCustomSource(params)
    case 'netease':
      return createNeteaseSource(params)
    case 'qq':
      return createQqSource(params)
    case 'spotify':
      return createSpotifySource(params)
    default:
      return undefined
  }
}
