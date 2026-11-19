/**
 * 把 MusicSource（可换源的媒体源）适配成系统能力层的 MediaResolver。
 *
 * 这是「解析媒体是通用能力」的落地：能力层只认 MediaResolver 接口、不知道背后是哪家源；
 * 换源只换注入的 MusicSource（createMusicSource 的 source 参数 / 测试注入 stub），无需改能力层与 skill。
 *
 * 参数映射：
 *  - MediaResolver.resolve({genre,artist,query}) → MusicSource.resolve(query ?? genre ?? artist)
 *    （音乐的「内容」用 genre 传，如「周杰伦的歌」「轻音乐」「评书」，见 musicControl 的 genreToKeyword）
 *  - ResolvedTrack{url,title,artist,channel,cover} → MediaAsset（加 source:'music'）
 *  - getSubtitle(title,artist) 注意 MusicSource 签名是 (artist,title)，这里交换参数顺序。
 */
import type { MediaAsset, MediaResolver } from '../../media/MediaPlaybackCapability'
import type { SubtitleLine } from '../../../protocol'
import type { MusicSource } from './music'

/** 从语义参数里取「内容关键词」：query 优先，其次 genre，最后 artist。 */
function contentKey(params: { genre?: string; artist?: string; query?: string }): string | undefined {
  return params.query?.trim() || params.genre?.trim() || params.artist?.trim() || undefined
}

function trackToAsset(track: {
  url: string; title: string; artist?: string; channel?: string; cover?: string
}): MediaAsset {
  return {
    source: 'music',
    url: track.url,
    title: track.title,
    ...(track.artist ? { artist: track.artist } : {}),
    ...(track.channel ? { channel: track.channel } : {}),
    ...(track.cover ? { cover: track.cover } : {}),
  }
}

/** 用 MusicSource 构造 MediaResolver；source 可注入替换（换源不改能力层/skill）。 */
export function createMusicResolver(source: MusicSource): MediaResolver {
  return {
    async resolve(params) {
      const track = await source.resolve(contentKey(params))
      return track ? trackToAsset(track) : null
    },
    async next(params) {
      if (!source.next) return null // 无「下一首」概念的源，交给能力层回退到 resolve
      const track = await source.next(params?.genre?.trim() || undefined)
      return track ? trackToAsset(track) : null
    },
    async getSubtitle(title: string, artist?: string): Promise<SubtitleLine[] | null> {
      if (!source.getSubtitle) return null
      // MusicSource.getSubtitle(artist, title) —— 注意参数顺序与本接口相反
      return source.getSubtitle(artist ?? '', title)
    },
  }
}
