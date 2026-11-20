/**
 * 内容播放执行层的通用契约（系统层，不含任何具体内容业务、不含 music 字样）。
 *
 * 网关核心（voiceSessionService）只认这里的接口：内容源解析、源→媒体解析器、内容执行器
 * 全部由装配层（controller）构造具体实现后注入。换源/换内容业务不改核心、不改本契约。
 */
import type { ServerEvent, SubtitleLine } from '../../protocol'
import type { MediaPlaybackCapability, MediaResolver } from '../media/mediaPlaybackCapability'

/** 通用内容源：把口语关键词解析成可播放媒体。backed by 具体实现（音乐源等），换源只换实现。 */
export interface ContentSource {
  resolve(genre?: string): { url: string; title: string; artist?: string; channel?: string; cover?: string } | Promise<{ url: string; title: string; artist?: string; channel?: string; cover?: string }>
  next?(genre?: string): { url: string; title: string; artist?: string; channel?: string; cover?: string } | Promise<{ url: string; title: string; artist?: string; channel?: string; cover?: string }>
  getSubtitle?(artist: string, title: string): Promise<SubtitleLine[] | null>
}

/** 把 ContentSource 适配成系统能力层的 MediaResolver（换源只换注入的实现）。 */
export type ContentResolverFactory = (source: ContentSource) => MediaResolver

/** 构造当前会话的内容源（kind 来自客户端设置页 playback.source；缺省由实现决定）。 */
export type ContentSourceFactory = (kind?: string) => ContentSource

/** 通用候选（语音选号用；与内容类型无关，可承载音乐/新闻/商品）。 */
export interface ContentCandidate {
  title: string
  artist?: string
  newsBvid?: string
  newsCover?: string
}

/** 可注入的候选检索器（测试用桩，避免联网）。 */
export type ContentCandidateFetcher = (
  url: string
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** 内容动作：只含「播什么」，通用控制（pause/stop/音量/字幕/循环）归 mediaControl。 */
export type ContentAction = 'play' | 'next' | 'recommend'

/** 执行器所需的会话级回调（由核心用 getter 读当前值构造，重武装即时生效）。 */
export interface ContentExecutorDeps {
  lang: () => string
  speak: (text: string) => Promise<void>
  send: (event: ServerEvent) => void
  queueRemaining: () => number
  media: MediaPlaybackCapability
  getSource: () => ContentSource | undefined
  candidateFetcher?: ContentCandidateFetcher
  defaultLoop: () => number
  defaultVolume: () => number
  autoLoop: () => boolean
  autoSubtitle: () => boolean
  clearNewsContext: () => void
  hasPendingDeals: () => boolean
  clearPendingDeals: () => void
  getLastTtsMedia: () => { url: string; title: string; audioPath?: string; cover?: string; lines: Array<{ time: number; text: string }> } | null
  playNewsVideo: (c: { bvid?: string; title: string; cover?: string }) => Promise<void>
  /** 长期记忆偏好关键词：无明确内容时据此个性化推荐（列候选让用户选），不自动播默认内容。 */
  getPreferenceKeywords?: () => Promise<string[]>
}

/** 内容执行器接口：核心只认它，不认任何具体内容业务类。 */
export interface ContentExecutor {
  run(action: ContentAction, text: string): Promise<void>
  nextFromClient(genre?: string): Promise<void>
  selectCandidate(text: string): Promise<boolean>
  consumeNextFallback(text: string): Promise<boolean>
  setCandidates(items: ContentCandidate[], query: string): void
  hasPendingCandidates(): boolean
  reset(reason: 'cancel' | 'end' | 'start'): void
}

/** dash 依赖由装配层注入，系统能力层与核心都不 import 具体内容域。 */
export interface ContentDashDeps {
  needsProxy: (channel?: string, url?: string) => boolean
}
