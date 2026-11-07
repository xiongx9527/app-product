import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { MediaDirective } from './musicTool'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const LYRICS_TOOL_NAME = 'get_lyrics'

const DESCRIPTIONS: Record<string, string> = {
  zh: '获取并展示某首歌的歌词。当用户问某首歌的歌词、想看歌词时调用，需传 artist（歌手）与 title（歌名）。歌词会下发到客户端展示。',
  en: 'Get and display the lyrics of a song. Call when the user asks for the lyrics of a song, with artist and title. The lyrics are sent to the client for display.',
}

const noopEmit = (_media: MediaDirective): void => undefined

/** 默认用全局 fetch；测试可注入桩，避免真实联网。 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/**
 * 创建「获取歌词」工具：用 lyrics.ovh 免费接口按 歌手+歌名 取歌词，
 * 下发 media.lyrics 给客户端展示，并返回给 LLM 的短确认文案。
 */
export function createLyricsTool(
  lang: Lang | string,
  emit?: (m: MediaDirective) => void,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: LYRICS_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      artist: z.string().describe('歌手名，如 周杰伦'),
      title: z.string().describe('歌名，如 七里香'),
    }),
    call: async (args: { artist: string; title: string }) => {
      const artist = encodeURIComponent(args?.artist ?? '')
      const title = encodeURIComponent(args?.title ?? '')
      const url = `https://api.lyrics.ovh/v1/${artist}/${title}`
      try {
        const res = await fetcher(url)
        if (!res.ok) {
          emit?.({ type: 'media.lyrics', title: args?.title ?? '', lyrics: '' })
          return prefix === 'en' ? 'No lyrics found.' : '没有找到这首歌的歌词。'
        }
        const data = (await res.json()) as { lyrics?: string }
        const lyrics = (data.lyrics ?? '').trim()
        if (!lyrics) {
          emit?.({ type: 'media.lyrics', title: args?.title ?? '', lyrics: '' })
          return prefix === 'en' ? 'No lyrics found.' : '没有找到这首歌的歌词。'
        }
        emit?.({
          type: 'media.lyrics',
          title: args?.title ?? '',
          artist: args?.artist,
          lyrics,
        })
        return prefix === 'en'
          ? `Lyrics of "${args?.title}" sent to the client.`
          : `已将《${args?.title}》的歌词下发到客户端展示。`
      } catch {
        emit?.({ type: 'media.lyrics', title: args?.title ?? '', lyrics: '' })
        return prefix === 'en'
          ? 'Could not reach the lyrics service.'
          : '无法连接歌词服务。'
      }
    },
  }
}
