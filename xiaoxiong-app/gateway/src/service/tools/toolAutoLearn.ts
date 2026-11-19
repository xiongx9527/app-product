/**
 * 通用自动学习包装器：给每个工具套上一层，让所有工具天然具备"自动学习"能力。
 *
 * 拦截工具 call 的入参（用户说的词）与返回（工具采用的规范词），交给通用 autoLearn 引擎
 * 的 learnFromAnchors——它从入参取用户词、从返回里按锚点（《》/播放：）取规范词，再按规则
 * 链判断。锚点提取而非滑动窗口切全文，避免"背诵《洛神赋》"的"背"被当正确词。
 *
 * 全程 fire-and-forget：学习绝不影响工具返回值、不阻塞、不抛错。
 */
import type { Tool } from '@agentscope-ai/agentscope/tool'
import type { AutoLearnEngine } from '../autoLearn'

/** 工具返回可能是 string 或 AgentScope 的 {content:[{type:'text',text}]}；统一取文本。 */
function resultText(res: unknown): string {
  if (typeof res === 'string') return res
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>
    if (typeof r.content === 'string') return r.content
    if (Array.isArray(r.content)) {
      return r.content.map((b: unknown) => {
        if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string') {
          return (b as Record<string, unknown>).text as string
        }
        return ''
      }).join(' ')
    }
    if (typeof r.text === 'string') return r.text
  }
  return ''
}

/** 从工具入参里拼出"用户输入的词"文本（常见字段）。 */
function inputText(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const parts: string[] = []
  for (const k of ['genre', 'query', 'keyword', 'name', 'content', 'wrong']) {
    const v = a[k]
    if (typeof v === 'string') parts.push(v)
  }
  return parts.join(' ')
}

/** 包装一个工具：保留 name/description/inputSchema，只替换 call，注入自动学习。 */
export function withAutoLearn(tool: Tool, engine: AutoLearnEngine): Tool {
  const originalCall = tool.call
  return {
    ...tool,
    async call(args: unknown) {
      const res = originalCall ? await originalCall(args as never) : (undefined as never)
      // 异步学习，不阻塞、不影响返回；锚点提取由引擎统一处理
      void engine.learnFromAnchors(inputText(args), resultText(res), { source: 'tool', tool: tool.name })
      return res
    },
  } as Tool
}
