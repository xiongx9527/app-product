import type { MusicFetcher, MusicSource } from '../types'
import { genreToKeyword, isGenreRequest } from '../types'
import { createSomaSource } from './somaSource'
import { createBilibiliSearchSource } from './bilibiliSearchSource'

/**
 * 百度播放源：风格/氛围请求走 SomaFM 免费电台，具体歌名/歌手走 B 站搜索兜底抽音轨；
 * 若 B 站原生搜索召回不足，再用百度 web 搜索找回 B 站视频页的 BVID（仅做检索，音轨仍从 B 站抽），
 * 标题依旧过严格匹配，绝不因为走百度就放松「歌手、歌名要一样」。
 * 两边都搜不到时由上层工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 *
 * 内部聚合 SomaFM 与 B 站两个子源，按关键词类型分流，并记住上一次用的子源，
 * 让 bare「换一首」沿用到同一来源（正在听周杰伦不会因没给新风格被路由到电台）。
 */
export function createBaiduMusicSource(fetcher: MusicFetcher): MusicSource {
  const soma = createSomaSource()
  const bili = createBilibiliSearchSource({}, fetcher)
  // 记住上一次播放用的是哪个子源（电台 or B 站），bare「换一首」要沿用到同一来源，
  // 否则正在听周杰伦却因没给新风格而被路由到 SomaFM 电台，变成完全不相关的歌。
  let lastSource: MusicSource = bili
  // 先用 genreToKeyword 把口语/指令词收敛成搜索词或风格词，再据此分流：
  // 风格词（轻音乐/电子/爵士…）→ SomaFM 电台；具体歌名/歌手 → B 站搜索兜底抽音轨。
  // 直接对原始输入用 isGenreRequest 会漏掉「随便放点/播放个音乐」这类泛化请求，
  // 把它们误送进视频搜索而播到不相关视频（乱播放）。
  return {
    async resolve(genre?: string) {
      const keyword = genreToKeyword(genre)
      const source = isGenreRequest(keyword) ? soma : bili
      lastSource = source
      return source.resolve(keyword)
    },
    async next(genre?: string) {
      // 没给新风格/歌手（纯粹「换一首/下一首」）：沿用上次播放的来源，让「换一首」
      // 和当前正在听的歌/电台有关联——B 站源会接着放同歌手的下一首，电台源则换台，
      // 而不是跳到不相关的电台/歌曲。
      if (genre === undefined || genre === null || genre === '') {
        return lastSource.next ? lastSource.next() : lastSource.resolve(undefined)
      }
      const keyword = genreToKeyword(genre)
      const source = isGenreRequest(keyword) ? soma : bili
      lastSource = source
      return source.next ? source.next(keyword) : source.resolve(keyword)
    },
  }
}
