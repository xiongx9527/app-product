import type { Lang, ServerEvent } from '../../protocol'
import type { Toolkit } from '@agentscope-ai/agentscope/tool'
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
import { createScheduleMusicTool } from './scheduleMusicTool'

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
export { createScheduleMusicTool, SCHEDULE_MUSIC_TOOL_NAME } from './scheduleMusicTool'


/**
 * 当前会话可用的工具集（函数调用）。
 * 新增工具：在 tools/ 下加一个文件实现 createXxxTool，然后在这里登记即可。
 * timezone 缺省为东八区（Asia/Shanghai），由网关配置覆盖；
 * locationProvider 实时读取会话最近一次上报的设备位置（位置/天气工具共用）；
 * reverseGeocoder 可选：配置了天地图 tk 时把经纬度翻成中文地址，未配置则位置工具退回客户端地址；
 * emit 可选：音乐类工具（播放/停止/歌词/预约）通过它把媒体指令下发给客户端，缺省则不下发（离线测试）。
 */
export function createToolkit(
  lang: Lang | string,
  timeZone: string = 'Asia/Shanghai',
  locationProvider: LocationProvider = () => null,
  reverseGeocoder?: ReverseGeocoder,
  emit?: (media: MediaDirective) => void
): Toolkit {
  const tools = [
    createCurrentTimeTool(lang, timeZone),
    createCurrentLocationTool(lang, locationProvider, reverseGeocoder),
    createWeatherTool(lang, locationProvider),
  ]
  // 媒体指令需要 emit 才能真正下发给客户端；没有 emit 时不注册音乐工具，避免空转
  if (emit) {
    tools.push(
      createMusicTool(lang, emit),
      createStopMusicTool(lang, emit),
      createMusicSearchTool(lang),
      createLyricsTool(lang, emit),
      createScheduleMusicTool(lang, emit)
    )
  }
  return new ToolkitImpl({ tools })
}

/** 供 voiceSessionService 把媒体指令转成 ServerEvent 透传给客户端。 */
export type MediaEmitter = (media: MediaDirective) => void
export const toServerEvent = (media: MediaDirective): ServerEvent => media
