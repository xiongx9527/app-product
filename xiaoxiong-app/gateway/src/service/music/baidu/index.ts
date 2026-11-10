import type { MusicFetcher, MusicSource } from '../types'
import type { SubtitleLine } from '../../../protocol'
import { genreToKeyword, isGenreRequest } from '../types'
import { createSomaSource } from './somaSource'
import { createBilibiliSearchSource, searchOrdered, type BiliResult } from './bilibiliSearchSource'
import { getBilibiliSubtitle } from './bilibiliAudio'
import { getNeteaseLyrics } from '../lyrics/neteaseLyrics'
import { getKugouLyrics } from '../lyrics/kugouLyrics'

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
    /**
     * 字幕同源取自 B 站：按「歌手 歌名」搜候选视频，逐个取 AI 字幕/官方字幕，
     * 命中即返回带时间的逐行字幕（供客户端跟随播放进度高亮）；都取不到返回 null（上层回退「暂无字幕」）。
     * 不跨源去调独立字幕服务。
     */
    async getSubtitle(artist: string, title: string): Promise<SubtitleLine[] | null> {
      const keyword = `${artist} ${title}`.trim()
      let ranked: BiliResult[] = []
      try {
        ranked = await searchOrdered(keyword, fetcher)
      } catch {
        return null
      }
      for (const r of ranked.slice(0, 5)) {
        const lines = await getBilibiliSubtitle(r.bvid, fetcher)
        if (lines && lines.length) return lines
      }
      // B 站无字幕时回退网易云歌词：覆盖大多数歌曲；网易云曲库受限的歌手（如周杰伦）取不到时返回 null。
      try {
        const nc = await getNeteaseLyrics(artist, title, fetcher)
        if (nc && nc.length) return nc
      } catch {
        // 网易云失败不影响播放，继续回退酷狗
      }
      // 网易云仍取不到时回退酷狗歌词：免登录、对有版权的歌手（如周杰伦）能补上词；取不到返回 null。
      try {
        const kg = await getKugouLyrics(artist, title, fetcher)
        if (kg && kg.length) return kg
      } catch {
        // 酷狗失败不影响播放，回退「暂无字幕」
      }
      return null
    },
  }
}
