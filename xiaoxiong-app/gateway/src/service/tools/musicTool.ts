import { z } from 'zod'
import type { Lang, ServerEvent } from '../../protocol'
import { messages } from '../../i18n'
import type { MusicSource } from '../music/types'
import { needsProxy } from '../music'
import { isSpokenContentRequest, MusicSourceNotImplementedError } from '../music/types'

/** 媒体指令：直接透传给客户端；客户端据此播放/停止/暂停/恢复/设音量/展示。 */
/**
 * 工具层可下发给客户端的「媒体/展示类」指令集合。
 * 除音乐播放控制外，也包含结构化详情卡片（开源项目结果等由工具直接产出卡片，
 * 与语音编号一一对应），因此这里是「工具→客户端」的通道，不只是音乐。
 */
export type MediaDirective = Extract<
  ServerEvent,
  {
    type:
      | 'media.play'
      | 'media.stop'
      | 'media.subtitle'
      | 'media.pause'
      | 'media.resume'
      | 'media.volume'
      | 'media.detail'
  }
>

/**
 * 自动字幕：开关开启时，用当前音乐源拉取字幕并下发 media.subtitle（随播放进度高亮）。
 * 尽力而为——拉取失败/超时不影响播放；取不到时也下发空 lyrics，让客户端显示「暂无字幕」而非什么都不提示。
 * artist 仅用于更精准地检索同源字幕，缺省时按 title 检索；ResolvedTrack 不含 artist 时传空串。
 */
export async function emitAutoSubtitles(
  getSource: () => MusicSource | undefined,
  emit?: (m: MediaDirective) => void,
  title = '',
  artist?: string,
  autoSubtitle = true
): Promise<void> {
  if (!autoSubtitle || !emit) return
  const source = getSource()
  if (!source?.getSubtitle) return
  try {
    const lines = await source.getSubtitle(artist ?? '', title)
    emit({ type: 'media.subtitle', title, artist, lines: lines ?? [] })
  } catch {
    // 字幕失败不影响播放
  }
}

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const MUSIC_TOOL_NAME = 'play_music'
export const STOP_MUSIC_TOOL_NAME = 'stop_music'
export const PAUSE_MUSIC_TOOL_NAME = 'pause_music'
export const RESUME_MUSIC_TOOL_NAME = 'resume_music'
export const NEXT_MUSIC_TOOL_NAME = 'next_music'

const DESCRIPTIONS: Record<string, string> = {
  zh: '开始播放音乐或音频内容。当用户想听歌、放点背景音乐、放点轻音乐/电子/爵士等，或想听/看 评书、相声、有声书、戏曲、电视剧、电影、动画片、漫剧、话剧、纪录片、综艺、讲座、故事、比赛，或说「看电影/我想看西游记动画片/看电视」时调用。视频类内容（电视/电影/动画/综艺/比赛…）会从 B 站提取音频播放，不是只能放音乐——所以这类请求也要用本工具，不要回复「无法播放视频」。可传 genre 指定内容（如“轻音乐”“电子”“爵士”，或“刘兰芳 岳飞传 评书”“郭德纲 相声”“三国演义 电视剧”“流浪地球 电影”“西游记 动画片”）。注意：仅用于「开始/重新播放」；已在播放时想换一个或换风格，用 next_music。',
  en: 'Start playing music or audio content. Call when the user wants to listen to music, background music, a genre like "chill"/"electronic"/"jazz"/"pop", or spoken content such as Chinese storytelling (pingshu), crosstalk (xiangsheng), audiobooks, opera, TV series, movies, cartoons, comic dramas, stage plays, documentaries, variety shows, lectures, stories or sports matches, or says "watch a movie / I want to watch the cartoon". Video content (TV/movie/animation/variety/sports…) is played by extracting its AUDIO track from Bilibili — it is NOT limited to music, so never reply "I cannot play video". Pass genre with the specific name (e.g. "Liu Lanfang Yue Fei Zhuan pingshu"). Only use it to START playback; to switch while already playing, use next_music.',
}

/**
 * 创建「播放音乐」工具：用注入的 MusicSource 按风格解析出可播放地址，下发 media.play。
 * emit 为空时不真正下发（便于离线测试），但仍返回确认文案。
 * source 用 getter 传入：播放源可随 session.playback 实时切换，无需重建智能体。
 */
export function createMusicTool(
  lang: Lang | string,
  getSource: () => MusicSource | undefined,
  emit?: (m: MediaDirective) => void,
  autoSubtitle = true,
  defaultLoop = 3,
  defaultVolume = 0.5,
  autoLoop = false
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: MUSIC_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      genre: z.string().optional().describe('内容，如 轻音乐/电子/爵士/流行，或 评书/相声/有声书/电视剧/电影/动画片/漫剧/话剧/纪录片/综艺/讲座/故事/比赛；视频类内容传作品名即可（如 流浪地球 电影、西游记 动画片）'),
      loop: z.number().int().min(1).max(99).optional().describe('循环播放遍数：总共播放几遍（含首遍）。缺省/1 表示不循环；>1 时客户端播完最后一遍自动重播直到达到遍数'),
    }),
    async call(args: { genre?: string; loop?: number }) {
      try {
        const source = getSource()
        if (!source) throw new Error('music source unavailable')
        const track = await source.resolve(args?.genre)
        // 有效循环次数：LLM 显式传 loop 优先；否则仅当「自动循环播放」开启时用默认循环次数；>1 才下发 loop。
        const loop = typeof args?.loop === 'number' && args.loop > 1 ? args.loop : autoLoop ? defaultLoop : undefined
        // 音量以默认值为起点：每次新播放下发 media.volume，供客户端按此设音量。
        emit?.({ type: 'media.volume', volume: defaultVolume })
        emit?.({
          type: 'media.play',
          url: track.url,
          title: track.title,
          channel: track.channel,
          proxy: needsProxy(track.channel, track.url),
          ...(loop && loop > 1 ? { loop } : {}),
          ...(track.cover ? { cover: track.cover } : {}),
        })
        // 自动字幕：开关开启时，播放这首歌后尽力同源拉取字幕并下发（无字幕则不显示）。
        void emitAutoSubtitles(getSource, emit, track.title, undefined, autoSubtitle)
        return prefix === 'en'
          ? `Now playing: ${track.title}. (${track.url})`
          : `正在为你播放：${track.title}。`
      } catch (e) {
        // 占位播放源尚未实现：明确告知用户该源不可用，引导改用百度搜索，
        // 绝不把「未实现」伪装成「没找到这首歌」误导用户。
        if (e instanceof MusicSourceNotImplementedError) {
          return messages(lang).music.notImplemented(e.sourceKind)
        }
        // 平台与百度都搜不到：明确告知，不播随机电台（避免乱播放）
        return prefix === 'en'
          ? `Sorry, I couldn't find that. Try another name?`
          : messages(lang).music.notFound(isSpokenContentRequest(args?.genre))
      }
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
  zh: '已经在播放时换一个 / 换个风格。不传 genre 表示同类型换一个（电台换台、歌曲取下一条）；传 genre（如“爵士”“电子”“流行”，或“郭德纲 相声”“流浪地球 电影”“西游记 动画片”）表示换成该内容。当用户说“换一首”“下一首”“换一段”“换个风格”“来点别的”“再看一个”时调用。视频类内容同样支持（提取音频播放）。',
  en: 'Switch to another track or style while audio is already playing. Omit genre to switch within the same type; pass a genre like "jazz", "electronic", "pop" to change style. Call on "next", "change style", etc. Video content is supported too (audio extracted).',
}

/**
 * 创建「换一首 / 换个风格」工具：用 MusicSource 的 next() 解析出与当前不同的曲目，下发 media.play。
 * 没有 next() 能力的源（如自定义电台）回退到 resolve，仍能让用户换风格重播。
 * source 用 getter 传入：播放源可随 session.playback 实时切换，无需重建智能体。
 */
export function createNextMusicTool(
  lang: Lang | string,
  getSource: () => MusicSource | undefined,
  emit?: (m: MediaDirective) => void,
  autoSubtitle = true,
  defaultLoop = 3,
  defaultVolume = 0.5,
  autoLoop = false
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: NEXT_MUSIC_TOOL_NAME,
    description: NEXT_DESCRIPTIONS[prefix] ?? NEXT_DESCRIPTIONS.zh,
    inputSchema: z.object({
      genre: z.string().optional().describe('新内容，如 爵士/电子/流行，或 评书/相声/电视剧/电影/动画片/漫剧/话剧/比赛；不传则同类型换一个'),
    }),
    async call(args: { genre?: string }) {
      try {
        const source = getSource()
        if (!source) throw new Error('music source unavailable')
        const track = await (source.next ? source.next(args?.genre) : source.resolve(args?.genre))
        // 音量以默认值为起点：每次新播放下发 media.volume。循环仅当「自动循环播放」开启时带入默认次数。
        emit?.({ type: 'media.volume', volume: defaultVolume })
        emit?.({
          type: 'media.play',
          url: track.url,
          title: track.title,
          channel: track.channel,
          proxy: needsProxy(track.channel, track.url),
          ...(autoLoop && defaultLoop > 1 ? { loop: defaultLoop } : {}),
          ...(track.cover ? { cover: track.cover } : {}),
        })
        // 自动字幕：开关开启时，换歌后尽力同源拉取字幕并下发（无字幕则不显示）。
        void emitAutoSubtitles(getSource, emit, track.title, undefined, autoSubtitle)
        return prefix === 'en'
          ? `Now playing: ${track.title}. (${track.url})`
          : `已为你切换到：${track.title}。`
      } catch (e) {
        // 占位播放源尚未实现：明确告知用户该源不可用，引导改用百度搜索
        if (e instanceof MusicSourceNotImplementedError) {
          return messages(lang).music.notImplemented(e.sourceKind)
        }
        // 平台与百度都搜不到：明确告知，不播随机电台（避免乱播放）
        return prefix === 'en'
          ? `Sorry, I couldn't find that. Try another name?`
          : messages(lang).music.notFound(isSpokenContentRequest(args?.genre))
      }
    },
  }
}
