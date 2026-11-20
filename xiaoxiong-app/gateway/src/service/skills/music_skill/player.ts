/**
 * 音乐播放业务（music_skill 的执行部分）——点歌/换一首/推荐/选号/候选。
 *
 * 边界（用户定稿「只清业务逻辑，协议/路径/文案块保留」）：
 *  - 这里是**音乐业务**：取 track、候选搜索/排序、播放决策、跨轮候选状态、口播确认。
 *  - 通用能力不在这里：dash 预热/短链/media.play 下发/字幕机制/播放状态机/通用控制
 *    （pause/stop/音量/字幕开关/循环遍数解析）全部在 media/ 系统能力层，这里只调用。
 *  - 跨业务状态（新闻切条/商品候选互斥/tts 媒体）通过回调协调，不在这里持有。
 *
 * 真机踩坑（搬迁时注释一起搬，不许丢）：
 *  - 换一首同名保护：仍拿到当前同名再换一次，仍同名交用户换风格，不重放同一首像没反应；
 *  - 候选 pendingCandidates：cancel 不清、end/全新 start 清、与商品候选互斥；
 *  - 「再」关上下文（hasAgainMarker）：再放稻香不按当前歌手直接播，重新列候选；
 *  - 问句「谁唱的歌/这首歌叫什么」不触发点歌，交 LLM 从正在播放上下文回答；
 *  - 措辞按 contentType：评书/戏曲/影视不说「这首歌」。
 */
import type { MediaAsset } from '../../media/mediaPlaybackCapability'
import type { ContentSource, ContentExecutor, ContentExecutorDeps, ContentAction, ContentCandidate } from '../../content/types'
import { pickI18n, type MusicI18n } from './i18n_player'
import { detectMusicCommand } from './detect'
import { parseLoopCount, hasAgainMarker } from '../../media/mediaIntent'
import { messages } from '../../../i18n'
import {
  searchCandidates, needsCandidateList, candidateQuery,
  contentWords, filterByCurrentArtist, isArtistBrowse,
  parseSelection, looksLikeSelectionAttempt,
} from './music/musicCandidates'
import {
  genreToKeyword, isSpokenContentRequest, detectContentType,
  MusicSourceNotImplementedError,
} from './music/types'

const FALLBACK_GENRES = ['轻音乐', '流行', '电子', '爵士', '民谣', '古典']
type Track = { url: string; title: string; channel?: string; cover?: string; artist?: string }

/** 执行器依赖 = 通用契约，无额外字段（内容业务类型不进核心）。 */
export type MusicPlayerDeps = ContentExecutorDeps

/** 内容源在本模块内的业务别名：结构等同 ContentSource，保留可读性。 */
type MusicSource = ContentSource

/** “换一首/换个风格”没给新偏好 → undefined（沿用当前歌手/风格）。 */
function nextPreference(text: string): string | undefined {
  if (!text) return undefined
  let kw = text
    .replace(/换一?首|下一?首|换个?风格|换一?个风格|切歌|来点别的|换台|换一?段|换段|下一?段|换一?集|换集|下一?集|换一?部|换部|换一?回|换回|再来一?段|来段别的|来个别的|换一个|换个|换一下|再来一个/g, '')
    .replace(/的/g, ' ').replace(/\s+/g, ' ').trim()
  kw = kw.replace(/^[放播唱听]\s*/, '')
  if (!kw) return undefined
  // 只剩泛化点歌词也算没给具体偏好（用 contentWords 判断：没有任何实义内容词）
  if (contentWords(kw).length === 0) return undefined
  return genreToKeyword(kw)
}

export class MusicPlayer implements ContentExecutor {
  private pendingCandidates: { items: ContentCandidate[]; query: string } | null = null
  private pendingNextFallback = false

  constructor(private readonly d: MusicPlayerDeps) {}

  hasPendingCandidates(): boolean { return this.pendingCandidates !== null }
  hasNextFallback(): boolean { return this.pendingNextFallback }
  /** 挂起候选列表（新闻搜索等多候选场景也共用选号机制）。 */
  setCandidates(items: ContentCandidate[], query: string): void {
    this.pendingCandidates = { items, query }
  }
  clearCandidates(): void {
    this.pendingCandidates = null
  }
  currentTitle(): string | undefined { return this.d.media.getLastMusic()?.title }
  currentArtist(): string | undefined { return this.d.media.getLastMusic()?.artist }
  currentContentType(): string | undefined { return this.d.media.getLastMusic()?.contentType }

  reset(reason: 'cancel' | 'end' | 'start'): void {
    if (reason === 'end' || reason === 'start') {
      this.pendingCandidates = null
      this.pendingNextFallback = false
    }
  }

  /** 客户端「换一首」按钮。 */
  async nextFromClient(genre?: string): Promise<void> {
    this.d.clearNewsContext()
    const source = this.d.getSource()
    if (!source) return
    const m = messages(this.d.lang()).music
    const query = genre || this.d.media.getLastMusic()?.artist || undefined
    const track = await this.nextTrack(source, query)
    if (!track) {
      this.pendingNextFallback = true
      await this.d.speak(m.offerOtherType())
      return
    }
    await this.playTrack(track, m.switched(track.title), undefined, undefined,
      detectContentType(track.title) ?? this.d.media.getLastMusic()?.contentType)
  }

  /**
   * 无明确内容时，结合长期记忆偏好列候选让用户选（绝不自动播默认电台）。
   * 依次试每个偏好词去搜候选，搜到就列候选 + 口播推荐文案；全搜不到返回 false，由调用方降级为引导反问。
   */
  private async recommendByPreference(m: MusicI18n): Promise<boolean> {
    const prefs = (await this.d.getPreferenceKeywords?.()) ?? []
    if (!prefs.length) return false
    for (const pref of prefs) {
      const items = await searchCandidates(pref, this.d.candidateFetcher)
      if (!items.length) continue
      const ranked = items.slice(0, 4)
      this.pendingCandidates = { items: ranked, query: pref }
      this.d.clearPendingDeals()
      const labels = ranked.map((c) => (c.artist ? `${c.title}，${c.artist}` : c.title))
      // 口播点出偏好依据，让用户知道是「根据你喜欢的X」推荐的（诚实、可解释）。
      await this.d.speak(`根据你喜欢的${pref}，${m.recommend(labels)}${m.chooseHint()}`)
      return true
    }
    return false
  }

  /** 执行音乐动作（play/next/recommend/loop 内容类；通用控制归 mediaControl）。 */
  async run(action: ContentAction, text: string): Promise<void> {
    // 只处理内容意图；通用控制（含 loop）由 media/mediaControl 先消费
    if (!['play', 'next', 'recommend'].includes(action)) return
    const source = this.d.getSource()
    if (!source) return
    const m = messages(this.d.lang()).music
    try {
      switch (action) {
        case 'recommend':
          await this.offer(source, text, true, true)
          break
        case 'play': {
          // recommend=false（点歌不是推荐口吻）；allowContext=!hasAgainMarker——「再放稻香」关上下文、列候选让用户选。
          if (await this.offer(source, text, isArtistBrowse(text), false, !hasAgainMarker(text))) break
          const genre = genreToKeyword(text)
          // 没有明确内容词（如「放首歌」「看。」「来点音乐」）：绝不自动播默认电台 Groove Salad。
          // 先结合长期记忆偏好列候选让用户选；偏好也搜不到就引导用户说清想听什么。
          if (contentWords(genre).length === 0) {
            if (await this.recommendByPreference(m)) break
            await this.d.speak(m.recommendPrompt())
            break
          }
          const track = await source.resolve(genre)
          if (!track?.url) throw new Error('no track')
          const loop = parseLoopCount(text)
          const words = contentWords(genre)
          const artist = words.length >= 2 ? words[0] : this.d.media.getLastMusic()?.artist
          await this.playTrack(track, m.playing(track.title), loop > 1 ? loop : undefined, artist,
            detectContentType(text) ?? detectContentType(track.title))
          break
        }
        case 'next': {
          const req = nextPreference(text) || this.d.media.getLastMusic()?.artist || undefined
          const track = await this.nextTrack(source, req)
          if (!track) {
            this.pendingNextFallback = true
            await this.d.speak(m.offerOtherType())
            break
          }
          await this.playTrack(track, m.switched(track.title), undefined, undefined,
            detectContentType(track.title) ?? this.d.media.getLastMusic()?.contentType)
          break
        }
      }
    } catch (e) {
      if (e instanceof MusicSourceNotImplementedError) {
        await this.d.speak(m.notImplemented(e.sourceKind))
        return
      }
      await this.d.speak(m.notFound(isSpokenContentRequest(text) || !!this.d.media.getLastMusic()?.contentType))
    }
  }

  /** 选第几条（核心在回声比对前调用）。 */
  async selectCandidate(text: string): Promise<boolean> {
    const pending = this.pendingCandidates
    if (!pending) return false
    const idx = parseSelection(text, pending.items)
    if (idx === null) {
      if (looksLikeSelectionAttempt(text)) {
        this.d.send({ type: 'asr.final', text, queueRemaining: this.d.queueRemaining() })
        const isNews = pending.items.some((c) => c.newsBvid)
        await this.d.speak(isNews ? messages(this.d.lang()).news.chooseAgain() : messages(this.d.lang()).music.chooseAgain())
        return true
      }
      return false
    }
    this.pendingCandidates = null
    this.d.send({ type: 'asr.final', text, queueRemaining: this.d.queueRemaining() })
    const chosen = pending.items[idx]
    if (chosen.newsBvid) { await this.d.playNewsVideo({ bvid: chosen.newsBvid, title: chosen.title, cover: chosen.newsCover }); return true }
    const source = this.d.getSource()
    if (!source) return true
    const keyword = pending.query && pending.query !== chosen.title ? `${pending.query} ${chosen.title}` : chosen.title
    try {
      const track = await source.resolve(keyword)
      if (!track?.url) throw new Error('no track')
      await this.playTrack(track, messages(this.d.lang()).music.playing(track.title), undefined, chosen.artist)
    } catch (e) {
      if (e instanceof MusicSourceNotImplementedError) await this.d.speak(messages(this.d.lang()).music.notImplemented(e.sourceKind))
      else await this.d.speak(messages(this.d.lang()).music.notFound(isSpokenContentRequest(keyword)))
    }
    return true
  }

  /** 「换一首没找到、用户是否同意换其它风格」——消费这句。 */
  async consumeNextFallback(text: string): Promise<boolean> {
    if (!this.pendingNextFallback) return false
    this.pendingNextFallback = false
    if (detectMusicCommand(text) === 'next' && nextPreference(text)) return false // 带了具体偏好，交正常流程
    const agree = /^(好|可以|行|嗯|要|就换|好的|好的呀|没问题|同意|是|对|换成|换个|换一个|再来一个|别的|其它|其他|换首其它的|来首其它的|来个其它的)$/.test((text ?? '').trim())
    if (!agree) return false
    this.d.send({ type: 'asr.final', text, queueRemaining: this.d.queueRemaining() })
    await this.playOtherType()
    return true
  }

  private async nextTrack(source: MusicSource, query?: string): Promise<Track | null> {
    try {
      let track = source.next ? await source.next(query) : await source.resolve(query)
      const lastTitle = this.d.media.getLastMusic()?.title
      if (lastTitle && track?.title === lastTitle) {
        const alt = source.next ? await source.next(query) : await source.resolve(query)
        if (!alt?.url || alt.title === lastTitle) return null
        track = alt
      }
      return track?.url ? track : null
    } catch { return null }
  }

  private async playOtherType(): Promise<void> {
    const source = this.d.getSource()
    if (!source) return
    const genre = FALLBACK_GENRES[Math.floor(Math.random() * FALLBACK_GENRES.length)]
    try {
      const track = await source.resolve(genre)
      if (!track?.url) return
      await this.playTrack(track, pickI18n(this.d.lang()).switchedOther())
    } catch { /* 静默 */ }
  }

  /** 候选（只有标题/歌手，无 url）→ resolve 出真 track 再播。 */
  private async playChosen(source: MusicSource, chosen: ContentCandidate, query: string): Promise<void> {
    const m = pickI18n(this.d.lang())
    const keyword = query && query !== chosen.title ? `${query} ${chosen.title}` : chosen.title
    try {
      const track = await source.resolve(keyword)
      if (!track?.url) throw new Error('no track')
      await this.playTrack(track, m.playing(track.title), undefined, chosen.artist)
    } catch (e) {
      if (e instanceof MusicSourceNotImplementedError) await this.d.speak(m.notImplemented(e.sourceKind))
      else await this.d.speak(m.notFound(isSpokenContentRequest(keyword)))
    }
  }

  private async offer(source: MusicSource, text: string, forceList: boolean, recommend: boolean, allowContext = true): Promise<boolean> {
    const genre = genreToKeyword(text)
    if (!needsCandidateList(genre) && !forceList) return false
    const query = candidateQuery(genre)
    const m = pickI18n(this.d.lang())
    if (!query) {
      if (forceList) { await this.d.speak(m.recommendPrompt()); return true }
      return false
    }
    const items = await searchCandidates(query, this.d.candidateFetcher)
    if (items.length === 0) {
      if (forceList || needsCandidateList(genre)) { await this.d.speak(m.notFound(isSpokenContentRequest(text))); return true }
      return false
    }
    if (items.length === 1 && !forceList) {
      await this.playChosen(source, items[0], query)
      return true
    }
    // 「再」关掉上下文（allowContext=false）时不按当前歌手收窄，全部列出让用户选；
    // 只有在某个歌手的播放会话里（allowContext=true）才优先挑同歌手版本直接播。
    const ranked = forceList || !allowContext ? items : filterByCurrentArtist(items, this.d.media.getLastMusic()?.artist)
    if (ranked.length < items.length) {
      await this.playChosen(source, ranked[0], query)
      return true
    }
    this.pendingCandidates = { items: ranked, query }
    this.d.clearPendingDeals()
    const labels = items.map((c) => (c.artist ? `${c.title}，${c.artist}` : c.title))
    await this.d.speak((recommend ? m.recommend(labels) : m.candidates(labels)) + m.chooseHint())
    return true
  }

  private async playTrack(
    track: Track, confirm: string,
    loop?: number, artist?: string, contentType?: string,
  ): Promise<void> {
    this.d.clearNewsContext()
    const effectiveLoop = loop && loop > 1 ? loop : this.d.autoLoop() ? this.d.defaultLoop() : undefined
    const asset = this.assetOf(track, effectiveLoop, artist ?? track.artist, contentType)
    this.playAsset(asset, confirm)
    void this.emitAutoSubtitle(track.title, artist ?? track.artist)
  }

  private assetOf(track: Track, loop?: number, artist?: string, contentType?: string): MediaAsset {
    return {
      source: 'music',
      url: track.url, title: track.title,
      ...(track.channel ? { channel: track.channel } : {}),
      ...(artist ?? track.artist ? { artist: artist ?? track.artist } : {}),
      ...(track.cover ? { cover: track.cover } : {}),
      ...(contentType ? { contentType } : {}),
      ...(loop && loop > 1 ? { loop } : {}),
    }
  }

  /** 真正下发播放：dash 预热/短链/字幕/状态机走系统能力层。 */
  private playAsset(asset: MediaAsset, confirm: string, reuseSubtitle = false): void {
    // 每次新播放都按最新默认音量下发（设置页可实时刷新，下次播放生效）；media.volume 在 play 之前。
    this.d.media.setVolume(this.d.defaultVolume())
    this.d.media.play(asset, { confirm, speak: this.d.speak, reuseSubtitle })
  }

  private async emitAutoSubtitle(title: string, artist?: string, reuse = false): Promise<boolean> {
    if (!this.d.autoSubtitle()) return false
    return this.d.media.ensureSubtitle(title, artist, reuse)
  }
}
