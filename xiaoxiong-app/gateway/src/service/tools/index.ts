import type { Lang } from '../../protocol'
import type { McpServerConfig } from '../../protocol'
import type { Toolkit, Tool } from '@agentscope-ai/agentscope/tool'
import { StdioMCPClient, HTTPMCPClient } from '@agentscope-ai/agentscope/mcp'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import {
  createCurrentLocationTool,
  type LocationProvider,
  type RequestLocation,
} from './currentLocationTool'
import { createLearnCorrectionTool } from './learnCorrectionTool'
import type { AutoLearnEngine } from '../autoLearn'
import { withAutoLearn } from './toolAutoLearn'
import {
  createRememberTool,
  createRecallTool,
  createForgetTool,
  type MemoryStore,
} from './memoryTool'

export {
  createCurrentLocationTool,
  formatLocation,
  LOCATION_TOOL_NAME,
  type LocationProvider,
  type RequestLocation,
} from './currentLocationTool'
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
 * 所有内容/商品/记忆直连意图走各自 skill，不再注册对应的 LLM 工具——
 * 工具箱只保留「系统能力型」工具：定位、长期记忆读写、ASR 纠错学习。
 * 媒体指令（诗词/百科朗读音频+字幕）由 skill 经 ctx.send 直接下发，不经 LLM 工具。
 */
export function createToolkit(
  lang: Lang | string,
  locationProvider: LocationProvider = () => null,
  memoryStore?: MemoryStore,
  requestLocation?: RequestLocation,
  /** 自动记忆（自动抽取）开关：来自客户端 session.start.memory.auto，缺省关。开启时助手才会主动调用 remember 沉淀长期记忆。 */
  autoMemory: boolean = false,
  /** 通用自动学习引擎：有则注册 learn_correction 工具并包装所有工具（agent 只依赖此抽象）。 */
  autoLearnEngine?: AutoLearnEngine
): Toolkit {
  // 定位工具用空 inputSchema + 0 参 call，与 AgentScope 的 Toolkit 类型一致；
  // 运行时 AgentScope 仍按 inputSchema 动态解析参数，断言不影响行为。
  const baseTools = [
    createCurrentLocationTool(lang, locationProvider, requestLocation),
  ]
  // 长期记忆工具：仅当本设备有记忆存储时注册（无 deviceId 的旧客户端不注册）。
  // 这样助手能「记住你的习惯」「忘了XX」，且记忆只落本机、按设备隔离。
  // remember（助手主动沉淀记忆）受自动记忆开关约束：关闭时只有手动指令（记录下 / 帮我记 等，
  // 由 memoryControl 直接命中、不走 LLM 工具）能写记忆；recall/forget 始终可用。
  const memoryTools: Tool[] = memoryStore
    ? [
        ...(autoMemory ? [createRememberTool(lang, memoryStore)] : []),
        createRecallTool(lang, memoryStore),
        createForgetTool(lang, memoryStore),
      ]
    : []
  // ASR 纠错学习工具：有学习引擎就注册（LLM 发现同音错字时调用，本地立即生效）
  const learnTools: Tool[] = autoLearnEngine
    ? [createLearnCorrectionTool(lang, autoLearnEngine)]
    : []
  // 工具统一经 withAutoLearn 包装：天然具备自动学习能力（等价父类能力）。
  // learnTools 不包：它自己就是显式学习工具（调 engine.learn 传准确参数），再包一层会从
  // 返回文案"记住了：错→对"里二次提取、学到"神父→神赋"这种子串错对（实测踩坑）。
  const autoLearnable = [...baseTools, ...memoryTools] as unknown as Tool[]
  const wrapped = autoLearnEngine
    ? [...autoLearnable.map((t) => withAutoLearn(t, autoLearnEngine)), ...learnTools]
    : [...autoLearnable, ...learnTools]
  return new ToolkitImpl({ tools: wrapped })
}

/**
 * 已连上的 MCP 客户端句柄：仅暴露关闭能力，供会话结束时回收 stdio 子进程等资源。
 * 不同传输的底层 client 形态不一，统一收敛成「名字 + 关闭」两件事。
 */
export interface McpClientHandle {
  name: string
  close(): Promise<void>
}

/** Promise 超时包裹：超过 ms 即 reject，避免某个 MCP 服务器连不上把会话卡死。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连接 MCP 服务器超时：${label}`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * 把一组 MCP 服务器连上并注册进工具箱。每个服务器独立 try/catch，单个失败只记日志并跳过，
 * 绝不拖垮整个会话。返回连接成功的客户端句柄，供会话结束时统一关闭。
 * - stdio：按 command/args/env 在网关侧拉起本地子进程。
 * - sse / http：按 url 走网络 endpoint（streable-http 或 SSE）。
 * 两者都需先 connect()（带 5s 超时），再 registerMCPClient 把工具挂进工具箱。
 */
export async function registerMcpServers(
  toolkit: Toolkit,
  servers: McpServerConfig[]
): Promise<McpClientHandle[]> {
  const clients: McpClientHandle[] = []
  for (const s of servers) {
    try {
      if (!s.name) throw new Error('MCP 服务器缺少 name')
      let client: StdioMCPClient | HTTPMCPClient
      if (s.transport === 'stdio') {
        if (!s.command) throw new Error('stdio 传输缺少 command')
        client = new StdioMCPClient({ name: s.name, command: s.command, args: s.args, env: s.env })
      } else {
        if (!s.url) throw new Error('sse/http 传输缺少 url')
        // 鉴权：把用户填写的自定义请求头透传给底层传输层（覆盖 Bearer / API Key / 自定义头）。
        // 没有 headers 时不传，行为与之前一致。
        const headers = s.headers && Object.keys(s.headers).length ? s.headers : undefined
        client = new HTTPMCPClient({
          name: s.name,
          transportType: s.transport === 'sse' ? 'sse' : 'streamable-http',
          url: s.url,
          transportOpts: headers ? { requestInit: { headers } } : undefined,
        })
      }
      await withTimeout(client.connect(), 5000, s.name)
      await toolkit.registerMCPClient({
        client,
        enabledTools: s.enabledTools,
        disabledTools: s.disabledTools,
      })
      clients.push({ name: s.name, close: () => client.close() })
    } catch (e) {
      // 单个 MCP 服务器连接失败：记录但不致命，助手其余能力照常工作
      console.warn(`[mcp] 连接服务器「${s.name ?? '未命名'}」失败，已跳过：`, (e as Error).message)
    }
  }
  return clients
}
