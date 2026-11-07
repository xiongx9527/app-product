import { z } from 'zod'
import type { Lang, ServerEvent } from '../../protocol'
import type { MusicSource } from '../music/types'

/** 媒体指令：直接透传给客户端；客户端据此播放/停止/暂停/恢复/展示。 */
export type MediaDirective = Extract<
  ServerEvent,
  { type: 'media.play' | 'media.stop' | 'media.lyrics' | 'media.pause' | 'media.resume' }
>

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const MUSIC_TOOL_NAME = 'play_music'
export const STOP_MUSIC_TOOL_NAME = 'stop_music'
export const PAUSE_MUSIC_TOOL_NAME = 'pause_music'
export const RESUME_MUSIC_TOOL_NAME = 'resume_music'
export const NEXT_MUSIC_TOOL_NAME = 'next_music'

const DESCRIPTIONS: Record<string, string> = {
  zh: '开始播放音乐。当用户想听歌、放点背景音乐、放点轻音乐/电子/爵士等，或刚唤醒后要放歌时调用。可传 genre 指定风格（如“轻音乐”“电子”“爵士”“流行”）。注意：仅用于「开始/重新播放」；已在播放时想换一首或换个风格，用 next_music。',
  en: 'Start playing music. Call when the user wants to listen to music or some background music, optionally with a genre like "chill", "electronic", "jazz", "pop". Only use it to START playback; to switch tracks while already playing, use next_music.',
}

/**
 * 创建「播放音乐」工具：用注入的 MusicSource 按风格解析出可播放地址，下发 media.play。
 * emit 为空时不真正下发（便于离线测试），但仍返回确认文案。
 */
export function createMusicTool(
  lang: Lang | string,
  source: MusicSource,
  emit?: (m: MediaDirective) => void
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: MUSIC_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      genre: z.string().optional().describe('风格，如 轻音乐/电子/爵士/流行'),
    }),
    async call(args: { genre?: string }) {
      const track = await source.resolve(args?.genre)
      emit?.({ type: 'media.play', url: track.url, title: track.title, channel: track.channel })
      return prefix === 'en'
        ? `Now playing: ${track.title}. (${track.url})`
        : `正在为你播放：${track.title}。`
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
    async call() {
      emit?.({ type: 'media.stop' })
      return prefix === 'en' ? 'Music stopped.' : '已停止播放。'
    },
  }
}

const PAUSE_DESCRIPTIONS: Record<string, string> = {
  zh: '暂停当前正在播放的音乐（保留进度，可恢复）。当用户说“暂停播放”“先停一下”“暂停”时调用。',
  en: 'Pause the music currently playing (keep progress, can be resumed). Call when the user asks to pause.',
}

/** 创建「暂停音乐」工具：下发 media.pause；纯客户端动作，无需网络。 */
export function createPauseMusicTool(lang: Lang | string, emit?: (m: MediaDirective) => void) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: PAUSE_MUSIC_TOOL_NAME,
    description: PAUSE_DESCRIPTIONS[prefix] ?? PAUSE_DESCRIPTIONS.zh,
    inputSchema: z.object({}),
    async call() {
      emit?.({ type: 'media.pause' })
      return prefix === 'en' ? 'Music paused.' : '已暂停播放。'
    },
  }
}

const RESUME_DESCRIPTIONS: Record<string, string> = {
  zh: '恢复（继续）被暂停的音乐。当用户说“继续播放”“接着放”“恢复”时调用。',
  en: 'Resume the paused music. Call when the user asks to continue or resume playback.',
}

/** 创建「恢复音乐」工具：下发 media.resume；纯客户端动作，无需网络。 */
export function createResumeMusicTool(lang: Lang | string, emit?: (m: MediaDirective) => void) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: RESUME_MUSIC_TOOL_NAME,
    description: RESUME_DESCRIPTIONS[prefix] ?? RESUME_DESCRIPTIONS.zh,
    inputSchema: z.object({}),
    async call() {
      emit?.({ type: 'media.resume' })
      return prefix === 'en' ? 'Music resumed.' : '已继续播放。'
    },
  }
}

const NEXT_DESCRIPTIONS: Record<string, string> = {
  zh: '已经在播放时换一首 / 换个风格。不传 genre 表示同类型换一首（电台换台、歌曲取下一条）；传 genre（如“爵士”“电子”“流行”）表示换成该风格。当用户说“换一首”“下一首”“换个风格”“来点别的”时调用。',
  en: 'Switch to another track or style while music is already playing. Omit genre to switch within the same type; pass a genre like "jazz", "electronic", "pop" to change style. Call on "next song", "change style", etc.',
}

/**
 * 创建「换一首 / 换个风格」工具：用 MusicSource 的 next() 解析出与当前不同的曲目，下发 media.play。
 * 没有 next() 能力的源（如自定义电台）回退到 resolve，仍能让用户换风格重播。
 */
export function createNextMusicTool(
  lang: Lang | string,
  source: MusicSource,
  emit?: (m: MediaDirective) => void
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: NEXT_MUSIC_TOOL_NAME,
    description: NEXT_DESCRIPTIONS[prefix] ?? NEXT_DESCRIPTIONS.zh,
    inputSchema: z.object({
      genre: z.string().optional().describe('新风格，如 爵士/电子/流行；不传则同类型换一首'),
    }),
    async call(args: { genre?: string }) {
      const track = await (source.next ? source.next(args?.genre) : source.resolve(args?.genre))
      emit?.({ type: 'media.play', url: track.url, title: track.title, channel: track.channel })
      return prefix === 'en'
        ? `Now playing: ${track.title}. (${track.url})`
        : `已为你切换到：${track.title}。`
    },
  }
}
