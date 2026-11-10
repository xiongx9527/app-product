import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { MediaDirective } from './musicTool'
import type { MusicSource } from '../music/types'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const SUBTITLE_TOOL_NAME = 'get_subtitle'

const DESCRIPTIONS: Record<string, string> = {
  zh: '获取并展示某首歌的字幕。当用户问某首歌的字幕、想看字幕时调用，需传 artist（歌手）与 title（歌名）。字幕来自当前播放源（与音乐同源），下发到客户端展示。注意：字幕只在客户端界面显示，不要念出/播报字幕内容，也不要在回复里复述字幕原文，简单告知已展示即可。',
  en: 'Get and display the subtitles of a song or video. Call when the user asks for the subtitles/lyrics of a song, with artist and title. Subtitles come from the active music source (same source as playback) and are sent to the client for display. Note: subtitles are shown on the client only — do NOT read the subtitle text aloud or repeat the lyrics in your reply; just confirm they are displayed.',
}

/**
 * 创建「获取字幕」工具：字幕由当前播放源自己提供（同源，不跨源调独立字幕服务）。
 * 通过 getMusicSource 取到源后调用其 getSubtitle(artist, title)；源不提供/取不到时回退「暂无字幕」。
 */
export function createSubtitleTool(
  lang: Lang | string,
  getMusicSource?: () => MusicSource | undefined,
  emit?: (m: MediaDirective) => void
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: SUBTITLE_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      artist: z.string().describe('歌手名，如 周杰伦'),
      title: z.string().describe('歌名，如 七里香'),
    }),
    async call(args: { artist: string; title: string }) {
      const source = getMusicSource?.()
      const lines = source?.getSubtitle
        ? await source.getSubtitle(args?.artist ?? '', args?.title ?? '')
        : null
      if (!lines || !lines.length) {
        emit?.({ type: 'media.subtitle', title: args?.title ?? '', lines: [] })
        return prefix === 'en' ? 'No subtitles found.' : '没有找到这首歌的字幕。'
      }
      emit?.({
        type: 'media.subtitle',
        title: args?.title ?? '',
        artist: args?.artist,
        lines,
      })
      return prefix === 'en'
        ? `Subtitles of "${args?.title}" sent to the client.`
        : `已将《${args?.title}》的字幕下发到客户端展示。`
    },
  }
}
