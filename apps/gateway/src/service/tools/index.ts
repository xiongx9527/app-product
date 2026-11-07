import type { Lang } from '../../protocol'
import type { Toolkit } from '@agentscope-ai/agentscope/tool'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import { createCurrentTimeTool } from './currentTimeTool'
import {
  createCurrentLocationTool,
  type LocationProvider,
} from './currentLocationTool'
import { createWeatherTool } from './weatherTool'
import type { ReverseGeocoder } from '../geocode/tiandituReverse'

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
  type ReverseGeocoder,
  type ReverseGeocodeResult,
} from '../geocode/tiandituReverse'


/**
 * 当前会话可用的工具集（函数调用）。
 * 新增工具：在 tools/ 下加一个文件实现 createXxxTool，然后在这里登记即可。
 * timezone 缺省为东八区（Asia/Shanghai），由网关配置覆盖；
 * locationProvider 实时读取会话最近一次上报的设备位置（位置/天气工具共用）；
 * reverseGeocoder 可选：配置了天地图 tk 时把经纬度翻成中文地址，未配置则位置工具退回客户端地址。
 */
export function createToolkit(
  lang: Lang | string,
  timeZone: string = 'Asia/Shanghai',
  locationProvider: LocationProvider = () => null,
  reverseGeocoder?: ReverseGeocoder
): Toolkit {
  return new ToolkitImpl({
    tools: [
      createCurrentTimeTool(lang, timeZone),
      createCurrentLocationTool(lang, locationProvider, reverseGeocoder),
      createWeatherTool(lang, locationProvider),
    ],
  })
}
