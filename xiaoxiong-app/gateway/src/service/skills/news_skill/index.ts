/**
 * 新闻播报 skill：识别「新闻/头条/发生了什么」→ 抓真实新闻视频、抽音轨走 media.play，
 * 多条列编号候选让用户语音选一条。业务全在本目录（detect/i18n/run/源）。
 *
 * 网关编排层只按 priority 把话递给 onDirectCommand，不含新闻业务。
 * 源可替换：newsVideoSource 由构造注入（换源/测试桩不改本 skill 代码）。
 * 跨域能力（dash 预热/短链/口播/下发）经 SkillContext 注入，不在这里实现。
 *
 * 跨轮状态（当前播哪批、第几条）放本 skill 闭包：选中的候选带 newsBvid，经 ctx.content.setCandidates
 * 挂给通用执行器；用户报号后执行器回调 playExternalVideo 回到这里抽音轨播放。
 */
import { detectNewsCommand, detectNewsNextCommand } from './detect'
import { pickNewsI18n } from './i18n'
import { createNewsVideoSource, cleanNewsTitle } from './news'
import type { NewsVideoSourceLike, NewsVideoCandidate } from './news'
import type { Skill, SkillContext, SkillModule } from '../types'

function makeNewsSkill(ctx: SkillContext, source: NewsVideoSourceLike): Skill {
  // 当前批次候选 + 正在播的下标（-1 未开始）；「下一条」据此接着切。
  let playback: { items: NewsVideoCandidate[]; index: number; keyword: string | null } | null = null

  const clearPlayback = () => { playback = null }

  /** 播放一条候选：抽音轨 → dash 短链 → media.play；标题只作展示不 TTS 合成。 */
  async function playVideo(c: { bvid?: string; title: string; cover?: string }): Promise<void> {
    const i = pickNewsI18n(ctx.lang)
    if (!c.bvid) return
    const video = await source.resolveBvid({ bvid: c.bvid, title: c.title, cover: c.cover })
    if (!video?.url) {
      await ctx.speak(i.unavailable())
      return
    }
    const title = cleanNewsTitle(video.title) || c.title
    // 同步「正在播第几条」，后续「下一条」从这条往后切。
    if (playback) {
      const idx = playback.items.findIndex((it) => it.bvid === c.bvid)
      if (idx >= 0) playback.index = idx
    }
    // 后台预热转封装，不阻塞播放；短链 key 与预热一致。
    if (ctx.mediaTools) void ctx.mediaTools.ensureAdts(video.url).catch(() => undefined)
    // 确认句不 await，避免阻塞 media.play；全文不进助手框。
    void ctx.speak(i.playing(title))
    ctx.send({
      type: 'media.play',
      url: '',
      title,
      ...(video.cover ? { cover: video.cover } : {}),
      ...(ctx.mediaTools ? { audioPath: `music/s/${ctx.mediaTools.adtsKey(video.url)}.aac` } : {}),
    })
  }

  /** 新一轮新闻：抓候选；单条直接播，多条挂候选让用户选。 */
  async function runNews(keyword: string | null): Promise<void> {
    const i = pickNewsI18n(ctx.lang)
    clearPlayback() // 新一轮先清旧上下文，抓取失败不留过期列表
    try {
      const hits = await source.search(keyword)
      const candidates = hits.slice(0, 3)
      if (!candidates.length) {
        await ctx.speak(i.none(keyword ?? undefined))
        return
      }
      playback = { items: candidates, index: -1, keyword }
      if (candidates.length === 1) {
        await playVideo(candidates[0])
        return
      }
      // 多条：挂候选（带 newsBvid，选中后走 playExternalVideo 而非点歌），与商品候选互斥。
      ctx.content?.setCandidates(
        candidates.map((c) => ({ title: c.title, newsBvid: c.bvid, newsCover: c.cover })),
        keyword ?? '',
      )
      ctx.content?.clearDeals()
      await ctx.speak(i.candidates(candidates.map((c) => c.title)) + i.chooseHint())
    } catch {
      await ctx.speak(i.unavailable())
    }
  }

  /** 播到下一条；播完如实告知并清上下文，引导重新抓一批（不静默循环）。 */
  async function playNext(): Promise<void> {
    if (!playback?.items.length) return
    const next = playback.index + 1
    if (next >= playback.items.length) {
      clearPlayback()
      await ctx.speak(pickNewsI18n(ctx.lang).noMore())
      return
    }
    await playVideo(playback.items[next])
  }

  return {
    matchesIntent(text) {
      return detectNewsCommand(text) !== null
    },
    async onDirectCommand(text) {
      // 新闻播放中的「下一条」必须先于音乐指令：这句本身无新闻词，detectNewsCommand 命中不了。
      if (playback && detectNewsNextCommand(text)) {
        await playNext()
        return { consumed: true }
      }
      const cmd = detectNewsCommand(text)
      if (!cmd) return undefined
      // 没说具体话题（如「播放新闻」）：结合长期记忆偏好搜，列候选让用户选；
      // 偏好搜不到就用 null keyword 走原有兜底（全量新闻/如实告知），不硬编内容。
      let keyword = cmd.keyword
      if (!keyword && ctx.getPreferenceKeywords) {
        const prefs = await ctx.getPreferenceKeywords()
        keyword = prefs.find((p) => p.length >= 2) ?? null
      }
      await runNews(keyword)
      return { consumed: true }
    },
    async playExternalVideo(c) {
      if (!c.bvid) return false
      await playVideo(c)
      return true
    },
    onMediaStop() {
      clearPlayback()
    },
    onSessionReset(reason) {
      if (reason === 'end' || reason === 'start') clearPlayback()
    },
  }
}

/** 工厂：默认用内置 B 站新闻源；换源/测试桩传 source 即可，detect/run/i18n 不变。 */
export function createNewsSkill(source?: NewsVideoSourceLike): SkillModule {
  return {
    id: 'news',
    name: '新闻播报',
    priority: 32, // 原顺序：天气(30)之后、百科(33)/诗词(35)/音乐(40)之前；play 正则含裸「播放」须在音乐前
    description: () => '',
    create: (ctx) => makeNewsSkill(ctx, source ?? createNewsVideoSource()),
  }
}

export const newsSkill: SkillModule = createNewsSkill()

export type { NewsVideoSourceLike, NewsVideoCandidate }
