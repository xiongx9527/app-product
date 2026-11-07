import type { MusicProviderKind, MusicSource } from './types'
import type { MusicInfo } from '../../protocol'
import { createSomaSource } from './somaSource'
import { createCustomSource } from './customSource'
import { createNeteaseSource } from './neteaseSource'
import { createQqSource } from './qqSource'
import { createSpotifySource } from './spotifySource'

export type { MusicProviderKind, MusicSource, MusicInfo }

/**
 * 按客户端上报的音乐配置构造播放源；与 geocode 的 createGeocodeAdapter 同构。
 * 未配置或厂商未知时返回 undefined，调用方据此不注册音乐工具。
 */
export function createMusicSource(config?: MusicInfo): MusicSource | undefined {
  if (!config?.provider) return undefined
  const kind = config.provider as MusicProviderKind
  const params = config.params ?? {}
  switch (kind) {
    case 'soma':
      return createSomaSource(params)
    case 'custom':
      return withSomaFallback(createCustomSource(params))
    case 'netease':
      return withSomaFallback(createNeteaseSource(params))
    case 'qq':
      return withSomaFallback(createQqSource(params))
    case 'spotify':
      return withSomaFallback(createSpotifySource(params))
    default:
      return undefined
  }
}

/**
 * 给非 SomaFM 的播放源包一层兜底：解析失败（网络/403/无直链/无 Key）或拿不到
 * 可播放地址时，自动回退到 SomaFM 免费电台，保证「播放音乐」总能出声，
 * 而不是甩一句「无法播放 / 找不到」。SomaFM 本身无需兜底。
 */
export function withSomaFallback(primary: MusicSource): MusicSource {
  const fallback = createSomaSource()
  return {
    async resolve(genre?: string) {
      try {
        const track = await primary.resolve(genre)
        if (track && track.url) return track
      } catch {
        // 解析失败，落到下面的兜底
      }
      return fallback.resolve(genre)
    },
    async next(genre?: string) {
      try {
        const track = primary.next ? await primary.next(genre) : await primary.resolve(genre)
        if (track && track.url) return track
      } catch {
        // 换一首失败，同样落到兜底电台
      }
      return fallback.next ? fallback.next(genre) : fallback.resolve(genre)
    },
  }
}
