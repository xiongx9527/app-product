import { z } from 'zod'
import type { Lang } from '../../protocol'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const MUSIC_SEARCH_TOOL_NAME = 'search_music'

const DESCRIPTIONS: Record<string, string> = {
  zh: '搜索歌曲或歌手（歌手+歌名或歌手名）。返回最相关的前几条结果（歌名、歌手、发行年），用于在对话里告知用户找到了什么。不负责播放。',
  en: 'Search for songs or artists by name. Returns the top matching results (title, artist, release year) so the assistant can tell the user what was found. Does not play anything.',
}

interface MusicBrainzRecording {
  title?: string
  'artist-credit'?: Array<{ name?: string }>
  releases?: Array<{ date?: string }>
}

/** 默认用全局 fetch；测试可注入桩，避免真实联网。 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

function formatResults(
  lang: Lang | string,
  recordings: MusicBrainzRecording[]
): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  if (!recordings.length) {
    return prefix === 'en' ? 'No matching songs found.' : '没有找到匹配的歌曲。'
  }
  const lines = recordings.slice(0, 5).map((r, i) => {
    const title = r.title || '?'
    const artist = r['artist-credit']?.[0]?.name || '?'
    const year = r.releases?.[0]?.date?.slice(0, 4) || ''
    return `${i + 1}. 《${title}》— ${artist}${year ? ` (${year})` : ''}`
  })
  return (prefix === 'en' ? 'Found:\n' : '找到：\n') + lines.join('\n')
}

/**
 * 创建「音乐搜索」工具：用 MusicBrainz 免费接口检索录音。
 * 返回纯文本结果给大模型组织回答，不触发播放。
 */
export function createMusicSearchTool(
  lang: Lang | string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: MUSIC_SEARCH_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      query: z.string().describe('歌名或歌手名，如 “周杰伦” 或 “七里香”'),
    }),
    call: async (args: { query: string }) => {
      const q = encodeURIComponent(args?.query ?? '')
      const url = `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=5`
      try {
        const res = await fetcher(url)
        if (!res.ok) {
          return prefix === 'en' ? 'Music search service error.' : '音乐搜索服务返回异常。'
        }
        const data = (await res.json()) as { recordings?: MusicBrainzRecording[] }
        return formatResults(lang, data.recordings ?? [])
      } catch {
        return prefix === 'en' ? 'Could not reach the music search service.' : '无法连接音乐搜索服务。'
      }
    },
  }
}
