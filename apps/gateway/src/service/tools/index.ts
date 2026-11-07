import type { Lang } from '../../protocol'
import type { Toolkit, Tool } from '@agentscope-ai/agentscope/tool'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import { createCurrentTimeTool } from './currentTimeTool'
import {
  createCurrentLocationTool,
  type LocationProvider,
} from './currentLocationTool'
import { createWeatherTool } from './weatherTool'
import type { ReverseGeocoder } from '../geocode/types'
import {
  createMusicTool,
  createStopMusicTool,
  type MediaDirective,
} from './musicTool'
import { createMusicSearchTool } from './musicSearchTool'
import { createLyricsTool } from './lyricsTool'
import type { MusicSource } from '../music/types'

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
} from './currentLocationTool'
export {
  createWeatherTool,
  formatWeather,
  WEATHER_TOOL_NAME,
} from './weatherTool'
export {
  createTiandituReverseGeocoder,
  gcj02ToWgs84,
  createGeocodeAdapter,
  type ReverseGeocoder,
  type ReverseGeocodeResult,
  type GeocodeConfig,
  type GeocodeProviderKind,
} from '../geocode'
export {
  createMusicTool,
  createStopMusicTool,
  MUSIC_TOOL_NAME,
  STOP_MUSIC_TOOL_NAME,
  type MediaDirective,
} from './musicTool'
export { createMusicSearchTool, MUSIC_SEARCH_TOOL_NAME } from './musicSearchTool'
export { createLyricsTool, LYRICS_TOOL_NAME } from './lyricsTool'


/**
 * 当前会话可用的工具集（函数调用）。
 * 新增工具：在 tools/ 下加一个文件实现 createXxxTool，然后在这里登记即可。
 * timezone 缺省为东八区（Asia/Shanghai），由网关配置覆盖；
 * locationProvider 实时读取会话最近一次上报的设备位置（位置/天气工具共用）；
 * reverseGeocoder 可选：配置了天地图 tk 时把经纬度翻成中文地址，未配置则位置工具退回客户端地址；
 * musicSource + emit 同时具备时才注册音乐类工具（播放/停止/搜索/歌词）：
 * 前者决定「播什么源」，后者决定「下发给客户端」；缺一（离线测试/未配置音乐源）则不注册。
 */
export function createToolkit(
  lang: Lang | string,
  timeZone: string = 'Asia/Shanghai',
  locationProvider: LocationProvider = () => null,
  reverseGeocoder?: ReverseGeocoder,
  musicSource?: MusicSource,
  emit?: (media: MediaDirective) => void
): Toolkit {
  // 网关既有工具（时间/位置/天气）都用空 inputSchema + 0 参 call，与 AgentScope 的 Toolkit 类型一致；
  // 音乐类工具需要入参（genre/minutes 等），zod 泛型在此边界不兼容，故整体按 Tool[] 断言。
  // 运行时 AgentScope 仍按 inputSchema 动态解析参数，断言不影响行为。
  const baseTools = [
    createCurrentTimeTool(lang, timeZone),
    createCurrentLocationTool(lang, locationProvider, reverseGeocoder),
    createWeatherTool(lang, locationProvider),
  ]
  // 媒体指令需要 emit 把指令下发给客户端，且需要 musicSource 决定播什么；
  // 两者都齐才注册音乐工具，否则（离线测试 / 客户端未配置音乐源）不注册，避免空转
  const musicTools: Tool[] = emit && musicSource
    ? [
        createMusicTool(lang, musicSource, emit),
        createStopMusicTool(lang, emit),
        createMusicSearchTool(lang),
        createLyricsTool(lang, emit),
      ]
    : []
  return new ToolkitImpl({ tools: [...baseTools, ...musicTools] as unknown as Tool[] })
}

/** 供 voiceSessionService 把媒体指令转成 ServerEvent 透传给客户端。 */
export type MediaEmitter = (media: MediaDirective) => void
