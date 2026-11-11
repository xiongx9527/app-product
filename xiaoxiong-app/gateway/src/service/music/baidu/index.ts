import type { MusicFetcher, MusicSource } from '../types'
import type { SubtitleLine } from '../../../protocol'
import { genreToKeyword, isGenreRequest } from '../types'
import { createSomaSource } from './somaSource'
import { createBilibiliSearchSource, searchOrdered, type BiliResult } from './bilibiliSearchSource'
import { getBilibiliSubtitle } from './bilibiliAudio'
import { resolveGequbaoTrack } from './gequbao'
import { joinArtistTitle } from '../lyrics/query'

/** 音频实际来自的同源标记：字幕必须与之同源，否则宁可不显示（避免歌词对不上）。 */
type AudioChannel = 'gequbao' | 'bilibili' | 'soma'

/**
 * 百度播放源：风格/氛围请求走 SomaFM 免费电台，具体歌名/歌手走 B 站搜索兜底抽音轨；
 * 若 B 站原生搜索召回不足，再用百度 web 搜索找回 B 站视频页的 BVID（仅做检索，音轨仍从 B 站抽），
 * 标题依旧过严格匹配，绝不因为走百度就放松「歌手、歌名要一样」。
 * 两边都搜不到时由上层工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 *
 * 字幕同源原则：字幕只取与「当前播放音频」同一来源、同一条目的，绝不跨源去配
 * （如歌曲宝的 mp3 配网易/酷狗的词，必然对不上）。歌曲宝音频用同一详情页的 LRC，
 * B 站音轨用 B 站视频字幕，电台无字幕；取不到一律返回空（客户端显示「暂无字幕」）。
 *
 * 内部聚合 SomaFM 与 B 站两个子源，按关键词类型分流，并记住上一次用的子源与音频同源标记，
 * 让 bare「换一首」沿用到同一来源（正在听周杰伦不会因没给新风格被路由到电台）。
 */
export function createBaiduMusicSource(fetcher: MusicFetcher): MusicSource {
  const soma = createSomaSource()
  const bili = createBilibiliSearchSource({}, fetcher)
  // 记住上一次播放用的是哪个子源（电台 or B 站），bare「换一首」要沿用到同一来源，
  // 否则正在听周杰伦却因没给新风格而被路由到 SomaFM 电台，变成完全不相关的歌。
  let lastSource: MusicSource = bili
  // 当前播放音频的同源标记：字幕据此只从同一源取，跨源不配。
  let lastAudioChannel: AudioChannel = 'bilibili'
  // 歌曲宝 resolve 时一次拿全的同源资源缓存（检索词 → 歌词/封面），供 getSubtitle 复用，
  // 保证字幕与音频来自同一详情页、同一首歌，且省掉播放后的二次检索。
  let gequbaoQuery = ''
  let gequbaoLyrics: SubtitleLine[] = []

  /** 切到非歌曲宝来源时清掉缓存，避免旧曲歌词被误当成新曲字幕。 */
  function clearGequbaoCache(): void {
    gequbaoQuery = ''
    gequbaoLyrics = []
  }

  // 先用 genreToKeyword 把口语/指令词收敛成搜索词或风格词，再据此分流：
  // 风格词（轻音乐/电子/爵士…）→ SomaFM 电台；具体歌名/歌手 → B 站搜索兜底抽音轨。
  // 直接对原始输入用 isGenreRequest 会漏掉「随便放点/播放个音乐」这类泛化请求，
  // 把它们误送进视频搜索而播到不相关视频（乱播放）。
  return {
    async resolve(genre?: string) {
      const keyword = genreToKeyword(genre)
      // 前瞻：具体歌名/歌手先试歌曲宝（gequbao），一次详情页拿全音频+封面+字幕；
      // 拿到则直接返回，换一首仍回到 B 站（避免反复试）。歌曲宝拿不到（限流/下架）回退 B 站。
      if (!isGenreRequest(keyword)) {
        const query = keyword || genre || ''
        try {
          const track = await resolveGequbaoTrack(query, fetcher)
          if (track) {
            lastSource = bili
            lastAudioChannel = 'gequbao'
            gequbaoQuery = query
            gequbaoLyrics = track.lyrics
            return {
              url: track.url,
              title: query,
              channel: 'gequbao',
              ...(track.cover ? { cover: track.cover } : {}),
              ...(track.artist ? { artist: track.artist } : {}),
            }
          }
        } catch {
          // 歌曲宝失败不影响，回退 B 站
        }
      }
      const source = isGenreRequest(keyword) ? soma : bili
      lastSource = source
      lastAudioChannel = isGenreRequest(keyword) ? 'soma' : 'bilibili'
      clearGequbaoCache()
      return source.resolve(keyword)
    },
    async next(genre?: string) {
      // 没给新风格/歌手（纯粹「换一首/下一首」）：沿用上次播放的来源，让「换一首」
      // 和当前正在听的歌/电台有关联——B 站源会接着放同歌手的下一首，电台源则换台，
      // 而不是跳到不相关的电台/歌曲。
      if (genre === undefined || genre === null || genre === '') {
        const track = lastSource.next ? await lastSource.next() : await lastSource.resolve(undefined)
        lastAudioChannel = lastSource === soma ? 'soma' : 'bilibili'
        clearGequbaoCache()
        return track
      }
      const keyword = genreToKeyword(genre)
      const source = isGenreRequest(keyword) ? soma : bili
      lastSource = source
      lastAudioChannel = isGenreRequest(keyword) ? 'soma' : 'bilibili'
      clearGequbaoCache()
      return source.next ? await source.next(keyword) : await source.resolve(keyword)
    },
    /**
     * 字幕同源取词：只从「当前播放音频」同一来源、同一条目取，跨源不配。
     *  - 歌曲宝：resolve 时已缓存同一详情页的 LRC，按检索词命中即直接返回（零二次检索、100% 同曲）；
     *    缓存未命中（如显式「显示某歌字幕」问的是别的歌）才在歌曲宝内重新解析，仍不跨源。
     *  - B 站：用 B 站视频自带字幕；
     *  - 电台：无字幕。
     * 都取不到返回 null（上层回退「暂无字幕」）。
     */
    async getSubtitle(artist: string, title: string): Promise<SubtitleLine[] | null> {
      const key = joinArtistTitle(artist, title)
      if (lastAudioChannel === 'gequbao') {
        if (key === gequbaoQuery) return gequbaoLyrics.length ? gequbaoLyrics : null
        // 缓存与本次请求的曲目不一致：仍只在歌曲宝内、对应用户给的歌手+歌名重新解析，绝不跨源
        try {
          const track = await resolveGequbaoTrack(key, fetcher)
          return track?.lyrics.length ? track.lyrics : null
        } catch {
          return null
        }
      }
      if (lastAudioChannel === 'bilibili') {
        let ranked: BiliResult[] = []
        try {
          ranked = await searchOrdered(key, fetcher)
        } catch {
          return null
        }
        for (const r of ranked.slice(0, 5)) {
          const lines = await getBilibiliSubtitle(r.bvid, fetcher)
          if (lines && lines.length) return lines
        }
        return null
      }
      // 电台/其它来源无字幕
      return null
    },
  }
}
