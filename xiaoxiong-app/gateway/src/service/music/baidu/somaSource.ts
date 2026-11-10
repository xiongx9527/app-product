import { pickChannel, SOMA_CHANNELS, DEFAULT_CHANNEL, type SomaChannel } from './musicChannels'
import { paramString, type MusicSource } from '../types'

/**
 * SomaFM 免费网络电台：无需 Key，直接 mp3 流。
 * 用户没说风格时用设置页选定的默认频道（station），说了风格按标签选台。
 * next() 切到与当前不同的频道，实现「换一首 / 下一首」。
 */
export function createSomaSource(
  params: Record<string, string | number | boolean> = {}
): MusicSource {
  const stationId = paramString(params, 'station', DEFAULT_CHANNEL)
  const fallback: SomaChannel = SOMA_CHANNELS.find((c) => c.id === stationId) ?? pickChannel()
  let lastId = fallback.id
  const pick = (genre?: string): SomaChannel => (genre ? pickChannel(genre) : fallback)
  return {
    resolve(genre?: string) {
      const channel = pick(genre)
      lastId = channel.id
      return {
        url: channel.url,
        title: channel.title.zh,
        channel: channel.id,
      }
    },
    next(genre?: string) {
      // 先排除当前频道，避免「换一首/换个风格」还放同一台；
      // 给了风格时优先在该风格下的其它频道里随机，更像「换个风格」
      const candidates = SOMA_CHANNELS.filter((c) => c.id !== lastId)
      let pool = candidates
      if (genre) {
        const matched = candidates.filter((c) =>
          c.tags.some((tag) => genre.toLowerCase().includes(tag))
        )
        if (matched.length) pool = matched
      }
      const channel = pool[Math.floor(Math.random() * pool.length)] ?? fallback
      lastId = channel.id
      return {
        url: channel.url,
        title: channel.title.zh,
        channel: channel.id,
      }
    },
  }
}
