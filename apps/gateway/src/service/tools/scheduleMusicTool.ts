import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { MediaDirective } from './musicTool'
import { pickChannel } from './musicChannels'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const SCHEDULE_MUSIC_TOOL_NAME = 'schedule_music'

const DESCRIPTIONS: Record<string, string> = {
  zh: '预约在一段时间后自动播放音乐。当用户说“半小时后放音乐”“10分钟后来点音乐”时调用，传 minutes（多少分钟后）和可选 genre（风格）。到点会自动在客户端开始播放。',
  en: 'Schedule music to start automatically after a delay. Call when the user says things like "play music in 30 minutes" with minutes (how many minutes later) and optional genre. It will auto-play on the client when the time comes.',
}

const noopEmit = (_media: MediaDirective): void => undefined

/**
 * 创建「预约播放」工具：用注入的 schedule（默认 setTimeout）挂定时器，到点下发 media.play。
 * 返回给 LLM 的短确认文案。会话结束/断线时定时器由调用方负责清理（见 voiceSessionService）。
 */
export function createScheduleMusicTool(
  lang: Lang | string,
  emit?: (m: MediaDirective) => void,
  schedule: (seconds: number, fire: () => void) => unknown = (seconds, fire) =>
    setTimeout(fire, seconds * 1000)
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: SCHEDULE_MUSIC_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      minutes: z.number().describe('多少分钟后开始播放'),
      genre: z.string().optional().describe('风格，如 轻音乐/电子/爵士/流行'),
    }),
    call: (args: { minutes?: number; genre?: string }) => {
      const minutes = Math.max(1, Math.min(1440, Math.round(Number(args?.minutes ?? 30) || 30)))
      const channel = pickChannel(args?.genre)
      const title = channel.title[prefix === 'en' ? 'en' : 'zh']
      emit?.({ type: 'media.scheduled', minutes, channel: channel.id })
      schedule(minutes * 60, () => {
        emit?.({
          type: 'media.play',
          url: channel.url,
          title,
          channel: channel.id,
        })
      })
      return prefix === 'en'
        ? `Scheduled to play ${title} in ${minutes} minutes.`
        : `已预约：${minutes} 分钟后播放 ${title}。`
    },
  }
}
