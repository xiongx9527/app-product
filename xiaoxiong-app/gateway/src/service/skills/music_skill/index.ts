/**
 * 音乐内容 skill：识别「点歌/换一首/推荐/选第几条」意图，委托系统能力执行。
 *
 * 职责边界（用户要求 control/ 跟 skill 走、源跟 skill 走、skill 只传语义参数）：
 *  - 本 skill 只做意图识别（detectMusicCommand 的 play/next/recommend + 选号），
 *    通过 ctx.content 回调把用户原话交给执行层（核心/能力层），不自己取媒体、不拼 media.play、
 *    不持有候选状态。执行层用能力层 MediaPlaybackCapability 播放（解析/预热/短链/字幕/状态机）。
 *  - 跨轮状态（候选列表/换风格兜底）与数据源由执行层持有，换源不改 skill。
 *  - pause/resume/stop/replay/loop 等通用控制不在这里——由 media/mediaControl 先消费。
 *
 * 说明：本 skill 是「意图入口」；具体播放实现暂由核心 content 回调承载（复用已验证的
 * offerCandidates/playTrack/nextMusic 等，含 dash 936字节/字幕复用/同名保护等真机踩坑），
 * 逐步再把执行实现搬进能力层/skill，保证每步行为不变、全量测试绿。
 */
import type { Skill, SkillContext, SkillModule } from '../types'
import type { ContentSource, ContentSourceFactory, ContentResolverFactory, ContentExecutor, ContentExecutorDeps, ContentDashDeps } from '../../content/types'
import { detectMusicCommand } from './detect'
import { parseSelection, looksLikeSelectionAttempt, looksLikeBareMusicQuery } from './music/musicCandidates'
import { createMusicSource, needsProxy } from './music'
import { createMusicResolver } from './resolver'
import { MusicPlayer } from './player'

function createMusicSkill(ctx: SkillContext): Skill {
  return {
    matchesIntent(text) {
      // 幻觉兜底：点歌/换一首/推荐等有效意图放行；含裸歌名（"周杰伦"）也算。
      return detectMusicCommand(text) !== null || looksLikeBareMusicQuery(text)
    },
    async onBareQuery(text) {
      // 只报一个歌手/作品名（无可辨识动词）：按点歌处理，交给能力层列候选或直接播。
      if (!ctx.content || !looksLikeBareMusicQuery(text)) return false
      return ctx.content.play(text)
    },
    async onDirectCommand(text) {
      const action = detectMusicCommand(text)
      if (!action) return undefined
      const content = ctx.content
      if (!content) return undefined
      switch (action) {
        case 'play':
          return { consumed: await content.play(text) }
        case 'next':
          return { consumed: await content.next(text) }
        case 'recommend':
          return { consumed: await content.recommend(text) }
        default:
          // pause/resume/stop/replay/loop 由 mediaControl 先消费；若漏到这里也不误处理
          return undefined
      }
    },

    async onFinalize(text) {
      // 选第几条：跨轮候选，必须在回声比对之前消费（由 core 在合适时机调 onFinalize）。
      // 用 looksLikeSelectionAttempt 快速判断，避免每句都问核心。
      if (!ctx.content || !looksLikeSelectionAttempt(text)) return undefined
      // parseSelection 需要候选列表，但 skill 不持有候选——交给核心的 select 回调判断。
      if (await ctx.content.select(text)) return { consumed: true }
      return undefined
    },
  }
}

export const musicSkill: SkillModule = {
  id: 'music',
  name: '音乐内容播放',
  priority: 40, // 通用控制（mediaControl 在 skill 之前独立处理）之后；时间(20)/天气(30)之后
  // LLM 主动播放的能力靠 description 提示（用户明确不要 play_media 工具）
  description: (lang) => lang.toLowerCase().startsWith('en')
    ? 'You can play music, audio books, radio and TV/movie soundtracks. When the user asks to play something, the system handles it directly; just reply naturally.'
    : '你能播放音乐、评书、有声书、电台、影视音轨等音频内容。用户明说要播放时系统会自动处理，你只需自然回应。',
  create: createMusicSkill,
}

/** 导出给核心/单测：选号尝试判断（避免对普通句子误问核心）。 */
export { parseSelection, looksLikeSelectionAttempt }

/**
 * 本 skill 提供的「内容播放能力工厂」——由 registry 自动收集后装配给核心。
 * skill 最了解自己的源/解析器/执行器实现，装配层与核心都不 import 具体 skill。
 */
export const contentFactories: {
  contentSourceFactory: ContentSourceFactory
  contentResolverFactory: ContentResolverFactory
  contentExecutorFactory: (deps: ContentExecutorDeps) => ContentExecutor
  contentDashDeps: ContentDashDeps
} = {
  contentSourceFactory: (kind) => createMusicSource({ source: kind }),
  contentResolverFactory: (source: ContentSource) => createMusicResolver(source),
  contentExecutorFactory: (deps) => new MusicPlayer(deps),
  contentDashDeps: { needsProxy },
}
