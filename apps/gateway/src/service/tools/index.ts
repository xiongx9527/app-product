import type { Lang } from '../../protocol'
import type { Toolkit } from '@agentscope-ai/agentscope/tool'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import { createCurrentTimeTool } from './currentTimeTool'
import { createCurrentLocationTool, type LocationProvider } from './currentLocationTool'

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


/**
 * 当前会话可用的工具集（函数调用）。
 * 新增工具：在 tools/ 下加一个文件实现 createXxxTool，然后在这里登记即可。
 * timezone 缺省为东八区（Asia/Shanghai），由网关配置覆盖；
 * locationProvider 实时读取会话最近一次上报的设备位置。
 */
export function createToolkit(
  lang: Lang | string,
  timeZone: string = 'Asia/Shanghai',
  locationProvider: LocationProvider = () => null
): Toolkit {
  return new ToolkitImpl({
    tools: [
      createCurrentTimeTool(lang, timeZone),
      createCurrentLocationTool(lang, locationProvider),
    ],
  })
}
