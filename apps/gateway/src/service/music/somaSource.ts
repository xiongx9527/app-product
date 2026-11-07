import { pickChannel, SOMA_CHANNELS, DEFAULT_CHANNEL, type SomaChannel } from '../tools/musicChannels'
import { paramString, type MusicSource } from './types'

/**
 * SomaFM 免费网络电台：无需 Key，直接 mp3 流。
 * 用户没说风格时用设置页选定的默认频道（station），说了风格按标签选台。
 */
export function createSomaSource(
  params: Record<string, string | number | boolean> = {}
): MusicSource {
  const stationId = paramString(params, 'station', DEFAULT_CHANNEL)
  const fallback: SomaChannel = SOMA_CHANNELS.find((c) => c.id === stationId) ?? pickChannel()
  return {
    resolve(genre?: string) {
      const channel = genre ? pickChannel(genre) : fallback
      return {
        url: channel.url,
        title: channel.title.zh,
        channel: channel.id,
      }
    },
  }
}
