import type { MusicFetcher, MusicSource, ResolvedTrack } from '../types'
import { MusicSourceNotImplementedError } from '../types'

/**
 * 酷狗音乐播放源（占位空实现）。
 *
 * 当前仅为注册占位：客户端设置页可选择「酷狗音乐」作为播放源，
 * 网关据此构造本源，但真实的搜索 / 播放直链解析尚未实现，
 * resolve 与 next 调用会抛出明确「未实现」错误，待后续补全
 * （kugou 搜索接口 + hash/album_id 解析 + 防盗链处理）。
 *
 * 后续实现须遵循顶层 music 模块的既定约定：
 *  - 风格/氛围请求走 SomaFM 免费电台兜底；
 *  - 具体歌名/歌手走酷狗搜索，严格匹配歌手与歌名，绝不放宽；
 *  - 两边都搜不到时由上层工具明确告知「没找到」，绝不退回随机电台。
 */
export function createKugouMusicSource(_fetcher: MusicFetcher): MusicSource {
  const notImplemented = (): never => {
    throw new MusicSourceNotImplementedError('kugou')
  }
  return {
    async resolve(): Promise<ResolvedTrack> {
      return notImplemented()
    },
    async next(): Promise<ResolvedTrack> {
      return notImplemented()
    },
  }
}
