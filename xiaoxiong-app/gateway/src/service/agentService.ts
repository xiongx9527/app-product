import { Agent } from '@agentscope-ai/agentscope/agent'
import type { ChatModelBase } from '@agentscope-ai/agentscope/model'
import { ReasoningChatModel } from './reasoningChatModel'
import { UserMsg } from '@agentscope-ai/agentscope/message'
import { EventType } from '@agentscope-ai/agentscope/event'
import { messages } from '../i18n'
import { bargeDiag } from '../diagLog'
import { getCredentialByType, getGlobalApiKey } from './credentialStore'
import { toolPrefix, injectCredential, injectGlobalApiKey } from './toolCredential'
import {
  parseToken, setMcpToken, getMcpTokenStyled, markTokenSuccess,
  isTokenExpired, isTokenFormatError, bumpFailStreak,
} from './mcpTokenCache'
import { enhanceToolDescriptions } from './toolDescEnhancer'
import type { DetailContext, Lang, McpServerConfig } from '../protocol'
import type { LlmConfig } from '../config'
import { createToolkit, registerMcpServers, type LocationProvider, type MemoryStore, type McpClientHandle, type RequestLocation } from './tools'
import type { AutoLearnEngine } from './autoLearn'
import { ChannelSplitter } from './channelSplitter'
import { createMemoryExtractor, type ExtractedMemory, type MemoryExtractor } from './memory'
import type { MemoryEntry } from './dataService'

/** 对话智能体服务：按语言本地化系统提示，流式回传文本增量。 */
export interface AgentService {
  reply(
    userText: string,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<string>
  /** 自动记忆抽取：从最近几句用户原话里抽取可长期记住的事实（开关关闭 / 离线模型时返回空）。 */
  extractMemories(history: string[], existing: MemoryEntry[]): Promise<ExtractedMemory[]>
  /** 自动记忆合并（摘要）：把当前全部记忆合并去重成更精炼的集合。 */
  consolidateMemories(existing: MemoryEntry[]): Promise<ExtractedMemory[]>
  /** 已连上的 MCP 客户端句柄：供会话结束时关闭 stdio 子进程等资源。 */
  mcpClients: McpClientHandle[]
  /** 关闭所有已连上的 MCP 客户端（stdio 子进程 / 网络连接），忽略单个关闭错误。 */
  closeMcp(): Promise<void>
}

/** 按配置构造真实的 LLM 模型实例（AgentScope 提供的各厂商实现）。 */
function createModel(cfg: LlmConfig, stream = true): ChatModelBase {
  const { provider, baseUrl, model, apiKey, params } = cfg
  switch (provider) {
    case 'builtin':
      // 内置：本地 AI 服务的 OpenAI 兼容层（/llm/v1 纯转发到任意上游），统一走 OpenAI 兼容接口。
      // 用 ReasoningChatModel（OpenAIChatModel 子类）：9529 把各厂商思考统一成 delta.reasoning_content，
      // 父类 OpenAIChatModel 不读该字段会丢掉思考块（思考框永远不显示），子类补上。
      // 本地服务不校验 key，apiKey 为空时用占位符，避免 OpenAI SDK 在构造时因缺凭证抛错拖垮进程。
      return new ReasoningChatModel({
        modelName: model,
        apiKey: apiKey || 'builtin-local',
        baseURL: baseUrl || undefined,
        stream,
        presetGenParams: params,
      })
    case 'dashscope':
      // 走 OpenAI 兼容层并显式带上 baseURL：这样用户填的「服务地址」（如自建 MAAS 实例
      // https://llm-xxx.maas.aliyuncs.com）才会真正被用上。DashScopeChatModel 不带 baseURL
      // 参数，只会打阿里云云端、无视用户配置，导致自定义端点（MAAS）「模型异常」。
      // 阿里云兼容模式与通用 OpenAI 兼容，OpenAIChatModel + baseURL 对云端 / 自定义端点一致生效。
      // 同样用 ReasoningChatModel 以兼容自定义端点返回的 reasoning_content。
      return new ReasoningChatModel({ modelName: model, apiKey, baseURL: baseUrl || undefined, stream, presetGenParams: params })
    default:
      throw new Error(`不支持的 LLM 提供方：${provider as string}`)
  }
}

export async function createAgentService(
  config: { llm: LlmConfig; timeZone?: string },
  lang: Lang,
  locationProvider: LocationProvider = () => null,
  memoryStore?: MemoryStore,
  memoryContext?: string,
  requestLocation?: RequestLocation,
  getNowPlaying?: () => { title: string; artist?: string; contentType?: string } | null,
  /** 自动记忆（自动抽取）开关：透传给 createToolkit，控制助手是否主动沉淀长期记忆。 */
  autoMemory?: boolean,
  /** MCP 服务器列表：客户端设置页下发，网关据此连上并把其工具注册进助手工具箱。 */
  mcpServers: McpServerConfig[] = [],
  /** 通用自动学习引擎：有则注册 learn_correction 工具并包装所有工具（agent 只依赖此抽象）。 */
  autoLearnEngine?: AutoLearnEngine,
  /** skill 注入的提示词片段：拼进 baseSysPrompt（必须在 refreshNowPlaying 之前），缺省空。 */
  promptAddon: string = '',
  /** 当前打开的详情上下文：每轮 reply 前读最新值拼进 systemPrompt，供 LLM 介绍/围绕商品聊天。 */
  getDetailContext?: () => DetailContext | null
): Promise<AgentService> {
  if (config.llm.provider === 'stub') return new StubAgentService()
  const model = createModel(config.llm)
  // 自动记忆抽取/合并引擎：复用同一套 createModel 构造独立模型实例，按开关在会话层触发。
  // 离线（stub）模型已在 createMemoryExtractor 内部短路返回空，这里直接构造即可。
  const memoryAuto: MemoryExtractor = createMemoryExtractor(lang, config.llm, createModel)
  const m = messages(lang)
  // 把该设备已记住的内容拼进系统提示（memoryContext 由会话层按 deviceId 加载并格式化），
  // 让助手在唤醒后自然参考用户习惯，而不是每次都从零开始问。无记忆时为空串，不影响原提示。
  // skill 提示词片段拼进 baseSysPrompt：refreshNowPlaying 每轮都从它重建 _sysPrompt，
  // 若只在构造时另加会被抹掉。片段之间用换行分隔，空片段不产生多余空白。
  const addon = promptAddon.trim()
  const baseSysPrompt = m.systemPrompt + (addon ? `\n${addon}` : '') + (memoryContext ?? '')
  // 工具箱先同步建好（保持 createToolkit 同步签名，4 个工具单测直接调用它）；
  // MCP 连接是异步的，必须在 Agent 构造之前 await 完，否则工具在首轮对话里尚未就绪。
  const toolkit = createToolkit(lang, locationProvider, memoryStore, requestLocation, autoMemory ?? false, autoLearnEngine)
  const mcpClients = await registerMcpServers(toolkit, mcpServers)
  // 工具自己告诉 LLM 凭据怎么用：对存在 access_token 工具的服务，动态给其工具描述补一句
  // 「先调 access_token 拿 token 再作为入参传入」。不写死业务名（前缀从工具名提取），不污染系统提示词。
  const enhanced = enhanceToolDescriptions((toolkit as unknown as { tools: Array<{ name?: string; description?: string; inputSchema?: unknown }> }).tools ?? [])
  if (enhanced.length) bargeDiag(`TOOL-DESC enhanced n=${enhanced.length}`)
  // 【常驻诊断】记录每次工具调用（含 MCP 工具）：真机只能经 /api/diag/log 观测
  // 「LLM 到底有没有触发 MCP」。
  // 【凭据自动注入】工具名 `xxx__` 前缀 = 账号本 type（用户自定义，如 askdata）。
  // 调用时按前缀查账号本，把 username/password 或 apiKey 合并进 input（不覆盖 LLM 已填的值），
  // 让 Agent 不必知道密码也能取 token。对 LLM 透明：它只写其它参数。
  // 工具 schema 的字段表：按它过滤注入字段，避免 additionalProperties:false 的工具报错。
  const toolSchemas = new Map<string, Set<string>>(
    toolkit.getJSONSchemas().map((s) => [
      s.function?.name ?? '', new Set(Object.keys(s.function?.parameters?.properties ?? {})),
    ])
  )
  const origCallTool = toolkit.callToolFunction.bind(toolkit)
  toolkit.callToolFunction = async function* (toolCall: any) {
    const name = String(toolCall?.name ?? '')
    bargeDiag(`TOOL-CALL name=${name}`)
    const allowed = toolSchemas.get(name)
    const allowedKeys = allowed ? [...allowed] : undefined
    try {
      // 1) 系统级通用 API Key：所有工具都带（只塞 schema 里存在的字段）
      const globalKey = getGlobalApiKey()
      if (globalKey) {
        const r = injectGlobalApiKey(toolCall.input, globalKey, allowedKeys)
        toolCall.input = r.input
        if (r.injected) bargeDiag(`TOOL-APIKEY injected global fields=${r.fields.join(',')}`)
      }
      // 2) MCP 工具（xxx__ 前缀）：额外按 type 取账号本凭据注入
      const prefix = toolPrefix(name)
      if (prefix) {
        const cred = await getCredentialByType(prefix)
        const result = injectCredential(toolCall.input, cred, allowedKeys)
        toolCall.input = result.input
        if (result.injected) bargeDiag(`TOOL-CRED injected prefix=${prefix} fields=${result.fields.join(',')}`)
        else if (!cred) bargeDiag(`TOOL-CRED none prefix=${prefix}`)
        // 3) mcp_* 兼容工具带 token 参数：注入 access_token 工具换到并缓存的 token。
        //    token 由账号本账号动态换取（每个账号自己的权限），绕开中转层静态 token 问题。
        const cachedToken = getMcpTokenStyled(prefix)
        if (cachedToken && allowedKeys?.includes('token')) {
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(toolCall.input || '{}') } catch { input = {} }
          if (!input.token) {
            input.token = cachedToken
            toolCall.input = JSON.stringify(input)
            bargeDiag(`TOOL-TOKEN injected prefix=${prefix}`)
          }
        }
      }
    } catch (e) {
      bargeDiag(`TOOL-CRED error name=${name} err=${(e as Error).message}`)
    }
    // 【常驻诊断】记录工具返回结果（state + 文本前 200 字）：真机只能经 /api/diag/log 观测，
    // 「工具触发了但回答出了问题」时靠它区分是工具失败还是 LLM 没接住结果。
    // 关键：AgentScope 的 Agent._acting 用「生成器返回值」当工具最终结果（done 时读 value.content），
    // 只在循环里 yield 而不 return 会让它读到 undefined.content 抛 TypeError，
    // 表现为「工具明明执行成功、模型却再没有任何输出」（真机「查询周边」无回答的真凶）。
    // 因此手动迭代、透传底层返回值；并把中间 yield 全部收齐后再判断是否需要 token 重试——
    // 避免把鉴权失败的错误结果先 yield 给 LLM，再重试造成两次输出。
    const runTool = async (tc: any): Promise<{ last: any; chunks: any[] }> => {
      const chunks: any[] = []
      const g = origCallTool(tc)
      let final: any
      while (true) {
        const { value, done } = await g.next()
        if (done) { final = value ?? final; break }
        chunks.push(value)
      }
      return { last: final, chunks }
    }
    const resultText = (last: any): string => {
      try {
        const content = last?.content
        if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ').slice(0, 200)
      } catch { /* ignore */ }
      return ''
    }
    let { last, chunks } = await runTool(toolCall)
    let text = resultText(last)

    // 【token 重试策略】仅 mcp_* 工具（prefix 存在、有 token 参数）且带账号本凭据：
    // - 401/token 失效 → 重新调 access_token 工具换 token（账号本账号密码），更新缓存后重试
    // - prefix/格式错误 → Bearer/裸 格式轮换；成功即标记写回缓存
    // - 兜底：bumpFailStreak 超过上限就跳过重试（避免死循环）
    const prefixForRetry = toolPrefix(name)
    const hasTokenArg = allowedKeys?.includes('token')
    const cred = prefixForRetry ? await getCredentialByType(prefixForRetry) : null
    if (last && prefixForRetry && hasTokenArg && cred
        && (isTokenExpired(text) || isTokenFormatError(text))
        && bumpFailStreak(prefixForRetry)) {
      const accessToolName = `${prefixForRetry}__access_token`
      let refreshed = false
      // 1) 先尝试重新调 access_token 工具换 token（用账号本凭据）
      try {
        const freshInput = injectCredential('{}', cred, undefined).input
        const fresh = await runTool({ name: accessToolName, input: freshInput })
        const freshToken = parseToken(resultText(fresh.last))
        if (freshToken) {
          setMcpToken(prefixForRetry, freshToken)
          refreshed = true
          bargeDiag(`TOOL-TOKEN refreshed prefix=${prefixForRetry}`)
        }
      } catch (e) {
        bargeDiag(`TOOL-TOKEN refresh error prefix=${prefixForRetry} err=${(e as Error).message}`)
      }
      // 2) 用新 token 重试原工具：先 Bearer，再裸（默认裸；格式错误才轮换）
      if (refreshed) {
        const fmtErrors = isTokenFormatError(text)
        const styles: Array<'bearer' | 'raw'> = fmtErrors ? ['bearer', 'raw'] : ['raw', 'bearer']
        for (const style of styles) {
          const tokenValue = getMcpTokenStyled(prefixForRetry)
          const styled = style === 'bearer'
            ? (tokenValue.toLowerCase().startsWith('bearer ') ? tokenValue : `Bearer ${tokenValue}`)
            : tokenValue.replace(/^Bearer\s+/i, '')
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(toolCall.input || '{}') } catch { input = {} }
          input.token = styled
          const retried = await runTool({ ...toolCall, input: JSON.stringify(input) })
          const retryText = resultText(retried.last)
          if (!isTokenExpired(retryText) && !isTokenFormatError(retryText)) {
            markTokenSuccess(prefixForRetry, styled)
            last = retried.last
            chunks = retried.chunks
            text = retryText
            bargeDiag(`TOOL-TOKEN retry ok prefix=${prefixForRetry} style=${style}`)
            break
          }
        }
      }
    }

    // 中间 yield 全部在重试完成后一次性发出（成功用重试结果，失败用原始结果）
    for (const c of chunks) yield c
    if (last) {
      const state = String(last.state ?? '?')
      bargeDiag(`TOOL-RESULT name=${name} state=${state} text="${text.replace(/\n/g, ' ')}"`)
      // access_token 工具成功 → 提取 token 按 type 缓存（裸 token），清零失败计数
      if (name.includes('__access_token') && state === 'success') {
        const token = parseToken(text)
        if (token) {
          markTokenSuccess(toolPrefix(name), token)
          bargeDiag(`TOOL-TOKEN cached prefix=${toolPrefix(name)}`)
        }
      }
    }
    return last
  } as unknown as typeof toolkit.callToolFunction
  const agent = new Agent({
    name: 'Xiong',
    sysPrompt: baseSysPrompt,
    model,
    toolkit,
  })
  // 当前播放曲目动态拼进系统提示：每轮 reply 前按最新曲目刷新，让助手能回答
  // 「现在播的什么歌 / 谁唱的」，而不必回「不知道」。Agent 只在 reply 时读 this.sysPrompt，
  // 这里更新其底层字段即可（不重建 Agent，避免丢失多轮对话上下文）。
  function refreshNowPlaying(): void {
    const now = getNowPlaying?.()
    const ctx = now ? m.nowPlayingContext(now.title, now.artist, now.contentType) : ''
    // 当前详情上下文：每轮读最新值，随 systemPrompt 重建（跨 agent 重武装不丢——值存在会话层）。
    const detail = getDetailContext?.()
    const detailCtx = detail ? m.detailContext(detail) : ''
    ;(agent as unknown as { _sysPrompt: string })._sysPrompt = baseSysPrompt + ctx + detailCtx
  }
  return {
    mcpClients,
    async closeMcp() {
      // 逐个关闭 MCP 客户端（stdio 子进程 / 网络连接），忽略单个关闭错误，避免影响整体结束流程
      await Promise.all(
        mcpClients.map((c) => c.close().catch(() => undefined))
      )
    },
    async reply(userText, onDelta, onThinking) {
      refreshNowPlaying()
      const stream = agent.replyStream({ msgs: UserMsg({ name: 'user', content: userText }) })
      // 推理模型会把思考过程连同控制符当作普通文本流下发，这里按 channel 拆开：
      // 思考走 onThinking（不进 TTS），最终答案走 onDelta。
      let full = ''
      const splitter = new ChannelSplitter(
        (s) => {
          full += s
          onDelta(s)
        },
        (s) => onThinking?.(s)
      )
      for await (const ev of stream) {
        if (ev.type === EventType.TEXT_BLOCK_DELTA) {
          splitter.push(ev.delta)
        } else if (ev.type === EventType.THINKING_BLOCK_DELTA) {
          // 思考过程只用于界面展示，不参与回复正文与 TTS
          onThinking?.(ev.delta)
        }
      }
      splitter.end()
      return full
    },
    extractMemories: (history, existing) => memoryAuto.extract(history, existing),
    consolidateMemories: (existing) => memoryAuto.consolidate(existing),
  }
}

/** 离线测试用 LLM：不联网，返回本地拼接的回包，便于在 CI / 无 Ollama 环境跑通语音流。 */
class StubAgentService implements AgentService {
  mcpClients: McpClientHandle[] = []
  async closeMcp(): Promise<void> {
    // 离线 stub 没有真实 MCP 客户端，无资源可释放
  }
  async reply(
    userText: string,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<string> {
    onThinking?.('（离线模式）先想一下该说什么。')
    const reply = `（离线回包）你刚才说：「${userText}」。这是本地 AgentScope 网关的离线回复，接上真实 LLM 后即为真实回答。`
    for (const piece of chunk(reply, 5)) {
      onDelta(piece)
      await delay(15)
    }
    return reply
  }
  async extractMemories(): Promise<ExtractedMemory[]> {
    return []
  }
  async consolidateMemories(): Promise<ExtractedMemory[]> {
    return []
  }
}

function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
