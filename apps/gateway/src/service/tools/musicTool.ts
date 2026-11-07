import { z } from 'zod'
import type { Lang, ServerEvent } from '../../protocol'
import { pickChannel } from './musicChannels'

/** 媒体指令：直接透传给客户端；客户端据此播放/停止/展示。 */
export type MediaDirective = Extract<
  ServerEvent,
  { type: 'media.play' | 'media.stop' | 'media.lyrics' | 'media.scheduled' }
>

/** 没有真实联网/无 emitter 时给调用方的兜底 no-op */
const noopEmit = (_media: MediaDirective): void => undefined

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const MUSIC_TOOL_NAME = 'play_music'
export const STOP_MUSIC_TOOL_NAME = 'stop_music'

const DESCRIPTIONS: Record<string, string> = {
  zh: '播放音乐。当用户想听音乐、放点背景音乐、放点轻音乐/电子/爵士等时调用。可传 genre 指定风格（如“轻音乐”“电子”“爵士”“流行”）。调用后会在客户端播放对应的网络电台。',
  en: 'Play music. Call when the user wants to listen to music or some background music, optionally with a genre like "chill", "electronic", "jazz", "pop". It starts a stream on the client.',
}

/**
 * 创建「播放音乐」工具：选 SomaFM 频道并下发 media.play 指令，返回给 LLM 的短确认。
 * emit 为空时不真正下发（便于离线测试），但仍返回确认文案。
 */
export function createMusicTool(lang: Lang | string, emit?: (m: MediaDirective) => void) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: MUSIC_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      genre: z.string().optional().describe('风格，如 轻音乐/电子/爵士/流行'),
    }),
    call: (args: { genre?: string }) => {
      const channel = pickChannel(args?.genre)
      const title = channel.title[prefix === 'en' ? 'en' : 'zh']
      emit?.({
        type: 'media.play',
        url: channel.url,
        title,
        channel: channel.id,
      })
      return prefix === 'en'
        ? `Now playing: ${title}. (${channel.url})`
        : `正在为你播放：${title}。`
    },
  }
}

const STOP_DESCRIPTIONS: Record<string, string> = {
  zh: '停止当前正在播放的音乐。当用户说“停止播放”“关掉音乐”“别放了”时调用。',
  en: 'Stop the music currently playing on the client. Call when the user asks to stop or turn off the music.',
}

/** 创建「停止音乐」工具：下发 media.stop；支持“停止播放”这类语音命令。 */
export function createStopMusicTool(lang: Lang | string, emit?: (m: MediaDirective) => void) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: STOP_MUSIC_TOOL_NAME,
    description: STOP_DESCRIPTIONS[prefix] ?? STOP_DESCRIPTIONS.zh,
    inputSchema: z.object({}),
    call: () => {
      emit?.({ type: 'media.stop' })
      return prefix === 'en' ? 'Music stopped.' : '已停止播放。'
    },
  }
}
