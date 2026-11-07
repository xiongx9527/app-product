import type { MusicFetcher, MusicSource } from './types'
import { genreToKeyword, isGenreRequest } from './types'
import { createSomaSource } from './somaSource'
import { createBilibiliSearchSource } from './bilibiliSearchSource'

export type { MusicSource }

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * 无配置的音乐聚合源，始终可用（不再有「未配置则不注册音乐工具」的概念）。
 * 分发规则：
 *  - 风格/氛围请求（轻音乐/电子/爵士…）→ SomaFM 免费电台；
 *  - 具体歌名/歌手请求 → B 站搜索兜底，抽到音轨返回可播放直链。
 * 两边都搜不到时由上层工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 */
export function createMusicSource(fetcher: MusicFetcher = nativeFetch): MusicSource {
  const soma = createSomaSource()
  const bili = createBilibiliSearchSource({}, fetcher)
  // 先用 genreToKeyword 把口语/指令词收敛成搜索词或风格词，再据此分流：
  // 风格词（轻音乐/电子/爵士…）→ SomaFM 电台；具体歌名/歌手 → B 站搜索兜底抽音轨。
  // 直接对原始输入用 isGenreRequest 会漏掉「随便放点/播放个音乐」这类泛化请求，
  // 把它们误送进视频搜索而播到不相关视频（乱播放）。
  return {
    async resolve(genre?: string) {
      const keyword = genreToKeyword(genre)
      const source = isGenreRequest(keyword) ? soma : bili
      return source.resolve(keyword)
    },
    async next(genre?: string) {
      const keyword = genreToKeyword(genre)
      const source = isGenreRequest(keyword) ? soma : bili
      return source.next ? source.next(keyword) : source.resolve(keyword)
    },
  }
}
