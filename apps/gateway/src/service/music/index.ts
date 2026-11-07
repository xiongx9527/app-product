import type { MusicFetcher, MusicSource } from './types'
import { isGenreRequest } from './types'
import { createSomaSource } from './somaSource'
import { createBaiduSource } from './baiduSource'

export type { MusicSource }

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * 无配置的音乐聚合源，始终可用（不再有「未配置则不注册音乐工具」的概念）。
 * 分发规则：
 *  - 风格/氛围请求（轻音乐/电子/爵士…）→ SomaFM 免费电台；
 *  - 具体歌名/歌手请求 → 百度搜索引擎兜底，抽到 B 站音轨返回可播放直链。
 * 两边都搜不到时由上层工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 */
export function createMusicSource(fetcher: MusicFetcher = nativeFetch): MusicSource {
  const soma = createSomaSource()
  const baidu = createBaiduSource({}, fetcher)
  const pick = (genre?: string): MusicSource => (isGenreRequest(genre) ? soma : baidu)
  return {
    async resolve(genre?: string) {
      const source = pick(genre)
      return source.resolve(genre)
    },
    async next(genre?: string) {
      const source = pick(genre)
      return source.next ? source.next(genre) : source.resolve(genre)
    },
  }
}
