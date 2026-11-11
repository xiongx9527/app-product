import type { Lang } from '../../protocol'
import type { Toolkit, Tool } from '@agentscope-ai/agentscope/tool'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import { createCurrentTimeTool } from './currentTimeTool'
import {
  createCurrentLocationTool,
  type LocationProvider,
  type RequestLocation,
} from './currentLocationTool'
import { createWeatherTool } from './weatherTool'
import {
  createMusicTool,
  createStopMusicTool,
  createPauseMusicTool,
  createResumeMusicTool,
  createNextMusicTool,
  type MediaDirective,
} from './musicTool'
import { createMusicSearchTool } from './musicSearchTool'
import { createSubtitleTool } from './subtitleTool'
import { createDealsTool } from './dealsTool'
import { createSmzdmSource, type DealsSource } from '../deals'
import { createOpenSourceTool } from './opensourceTool'
import { createOschinaSource, type OpenSourceSource } from '../opensource'
import type { MusicSource } from '../music/types'
import {
  createRememberTool,
  createRecallTool,
  createForgetTool,
  type MemoryStore,
} from './memoryTool'

export {
  createCurrentTimeTool,
  formatNow,
  TIME_TOOL_NAME,
} from './currentTimeTool'
export {
  createCurrentLocationTool,
  formatLocation,
  LOCATION_TOOL_NAME,
  type LocationProvider,
  type RequestLocation,
} from './currentLocationTool'
export {
  createWeatherTool,
  formatWeather,
  WEATHER_TOOL_NAME,
} from './weatherTool'
export {
  createMusicTool,
  createStopMusicTool,
  createPauseMusicTool,
  createResumeMusicTool,
  createNextMusicTool,
  MUSIC_TOOL_NAME,
  STOP_MUSIC_TOOL_NAME,
  PAUSE_MUSIC_TOOL_NAME,
  RESUME_MUSIC_TOOL_NAME,
  NEXT_MUSIC_TOOL_NAME,
  type MediaDirective,
} from './musicTool'
export { createMusicSearchTool, MUSIC_SEARCH_TOOL_NAME } from './musicSearchTool'
export { createSubtitleTool, SUBTITLE_TOOL_NAME } from './subtitleTool'
export { createDealsTool, DEALS_TOOL_NAME } from './dealsTool'
export { createSmzdmSource, parseDeals, formatDeals, filterDeals, type Deal, type DealsSource, type DealsFetcher, type DealsOptions } from '../deals'
export { createOpenSourceTool, OPENSOURCE_TOOL_NAME } from './opensourceTool'
export { createOschinaSource, parseOschina, formatProjects, filterProjects, type OpenSourceProject, type OpenSourceSource, type OpenSourceFetcher, type OpenSourceOptions } from '../opensource'
export {
  createRememberTool,
  createRecallTool,
  createForgetTool,
  formatMemories,
  type MemoryStore,
} from './memoryTool'


/**
 * 当前会话可用的工具集（函数调用）。
 * 新增工具：在 tools/ 下加一个文件实现 createXxxTool，然后在这里登记即可。
 * timezone 缺省为东八区（Asia/Shanghai），由网关配置覆盖；
 * locationProvider 实时读取会话最近一次上报的设备位置（位置/天气工具共用）；
 * musicSource + emit 同时具备时才注册音乐类工具（播放/停止/搜索/字幕）：
 * 前者决定「播什么源」，后者决定「下发给客户端」；缺一（离线测试/未配置音乐源）则不注册。
 * dealsSource 为好价数据源，由组合根注入，缺省用 smzdm 源；后续接新源只换这里。
 * opensourceSource 为开源工具/软件数据源，缺省用 oschina 源；后续接新源只换这里。
 */
export function createToolkit(
  lang: Lang | string,
  timeZone: string = 'Asia/Shanghai',
  locationProvider: LocationProvider = () => null,
  getMusicSource?: () => MusicSource | undefined,
  emit?: (media: MediaDirective) => void,
  memoryStore?: MemoryStore,
  requestLocation?: RequestLocation,
  autoSubtitle?: boolean,
  defaultLoop?: number,
  defaultVolume?: number,
  autoLoop?: boolean,
  dealsSource: DealsSource = createSmzdmSource(),
  opensourceSource: OpenSourceSource = createOschinaSource()
): Toolkit {
  // 网关既有工具（时间/位置/天气）都用空 inputSchema + 0 参 call，与 AgentScope 的 Toolkit 类型一致；
  // 音乐类工具需要入参（genre/minutes 等），zod 泛型在此边界不兼容，故整体按 Tool[] 断言。
  // 运行时 AgentScope 仍按 inputSchema 动态解析参数，断言不影响行为。
  const baseTools = [
    createCurrentTimeTool(lang, timeZone),
    createCurrentLocationTool(lang, locationProvider, requestLocation),
    createWeatherTool(lang, locationProvider, undefined, requestLocation),
    createDealsTool(lang, { source: dealsSource }),
    createOpenSourceTool(lang, { source: opensourceSource }),
  ]
  // 媒体指令需要 emit 把指令下发给客户端，且需要 musicSource 决定播什么；
  // 两者都齐才注册音乐工具，否则（离线测试 / 客户端未配置音乐源）不注册，避免空转。
  // musicSource 用 getter 传入，使 session.playback 实时切换源无需重建智能体。
  const musicTools: Tool[] = emit && getMusicSource
    ? [
        createMusicTool(lang, getMusicSource, emit, autoSubtitle, defaultLoop, defaultVolume, autoLoop),
        createStopMusicTool(lang, emit),
        createPauseMusicTool(lang, emit),
        createResumeMusicTool(lang, emit),
        createNextMusicTool(lang, getMusicSource, emit, autoSubtitle, defaultLoop, defaultVolume, autoLoop),
        createMusicSearchTool(lang),
        createSubtitleTool(lang, getMusicSource, emit),
      ]
    : []
  // 长期记忆工具：仅当本设备有记忆存储时注册（无 deviceId 的旧客户端不注册）。
  // 这样助手能「记住你的习惯」「忘了XX」，且记忆只落本机、按设备隔离。
  const memoryTools: Tool[] = memoryStore
    ? [
        createRememberTool(lang, memoryStore),
        createRecallTool(lang, memoryStore),
        createForgetTool(lang, memoryStore),
      ]
    : []
  return new ToolkitImpl({ tools: [...baseTools, ...musicTools, ...memoryTools] as unknown as Tool[] })
}

/** 供 voiceSessionService 把媒体指令转成 ServerEvent 透传给客户端。 */
export type MediaEmitter = (media: MediaDirective) => void
