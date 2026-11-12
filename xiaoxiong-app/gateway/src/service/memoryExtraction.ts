import { z } from 'zod'
import { UserMsg } from '@agentscope-ai/agentscope/message'
import { Toolkit as ToolkitImpl } from '@agentscope-ai/agentscope/tool'
import type { Lang } from '../protocol'
import type { LlmConfig } from '../config'
import type { MemoryEntry } from './dataService'
import { messages } from '../i18n'

/** 一条被抽取/合并出的记忆：话题标签 + 精炼内容。 */
export interface ExtractedMemory {
  key: string
  value: string
}

/** 抽取/合并引擎：把对话里的稳定事实抽出来，或把零散记忆合并成精炼集合。 */
export interface MemoryExtractor {
  /** 从最近几句用户原话中抽取可长期记住的事实；返回空数组表示这一轮没什么值得记的。 */
  extract(history: string[], existing: MemoryEntry[]): Promise<ExtractedMemory[]>
  /** 把当前全部记忆合并去重成更精炼的集合（摘要）。 */
  consolidate(existing: MemoryEntry[]): Promise<ExtractedMemory[]>
}

/** 抽取工具名；抽取/合并都复用同一个工具，靠提示词区分语义。 */
const EXTRACT_TOOL = 'remember_many'

/** 把已存记忆格式化成「- key：value」清单，供抽取/合并提示注入。 */
export function formatExisting(entries: MemoryEntry[]): string {
  if (!entries.length) return ''
  return entries.map((e) => `- ${e.key}：${e.value}`).join('\n')
}

/** 把最近几句用户原话拼成编号段落，作为抽取输入；空白句会被剔除。 */
export function buildHistoryText(history: string[]): string {
  const clean = history.filter((h) => h && h.trim()).map((h) => h.trim())
  if (!clean.length) return ''
  return clean.map((h, i) => `${i + 1}. ${h}`).join('\n')
}

function langPrefix(lang: Lang | string): 'zh' | 'en' {
  return (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0] === 'en' ? 'en' : 'zh'
}

/** 把模型工具调用返回的 input（JSON 串）解析成抽取条目；解析失败/结构不对都返回空，绝不丢异常。 */
export function parseExtractorInput(input: string | undefined): ExtractedMemory[] {
  if (!input) return []
  try {
    const parsed = JSON.parse(input) as { entries?: Array<{ key?: string; value?: string }> }
    const entries = parsed?.entries
    if (!Array.isArray(entries)) return []
    return entries
      .map((e) => ({ key: (e?.key ?? '').trim(), value: (e?.value ?? '').trim() }))
      .filter((e) => e.key && e.value)
  } catch {
    return []
  }
}

/**
 * 构建记忆抽取/合并引擎。
 * - 离线（stub）模型不参与：返回空操作，既不联网也不消耗真实 LLM。
 * - 真实模型：直接调用 model.call 并强制 tool_choice=remember_many，保证模型一定以工具调用
 *   形式返回结构化结果。Agent 的 reply 接口把 tool_choice 写死成 'auto' 无法强制，故绕过 Agent 直打模型。
 * makeModel 注入 createModel，避免与 agentService 形成循环依赖；stream 关掉以拿到一次性结果。
 */
export function createMemoryExtractor(
  lang: Lang | string,
  llm: LlmConfig,
  makeModel: (cfg: LlmConfig, stream?: boolean) => unknown
): MemoryExtractor {
  if (llm.provider === 'stub') {
    return {
      async extract() {
        return []
      },
      async consolidate() {
        return []
      },
    }
  }
  const p = langPrefix(lang)
  const m = messages(lang)
  const tool = {
    name: EXTRACT_TOOL,
    description:
      p === 'en'
        ? 'Save the durable facts extracted from the conversation. Pass an array of {key, value}; empty array if nothing worth saving.'
        : '保存从对话中抽取出的可长期记忆的事实。传入 {key, value} 数组；没有值得记的传空数组。',
    inputSchema: z.object({
      entries: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
    // 实际写入由调用方（会话层）负责，这里只需占位返回；结果从工具调用的 input 解析。
    async call() {
      return 'ok'
    },
  }
  // 用 Toolkit 把工具定义转成 LLM 需要的 JSON Schema，复用与 Agent 同一套序列化。
  const toolkit = new ToolkitImpl({ tools: [tool as unknown as never] })
  const schemas = toolkit.getJSONSchemas()
  const model = makeModel(llm, false) as {
    call: (opts: {
      messages: unknown[]
      tools: unknown[]
      toolChoice: string
    }) => Promise<{ content?: Array<{ type: string; name?: string; input?: string }> }>
  }

  async function runAgainstTool(systemText: string, userText: string): Promise<ExtractedMemory[]> {
    try {
      const res = await model.call({
        messages: [UserMsg({ name: 'user', content: `${systemText}\n\n${userText}` })],
        tools: schemas,
        toolChoice: EXTRACT_TOOL,
      })
      const block = res.content?.find((c) => c.type === 'tool_call')
      return parseExtractorInput(block?.input)
    } catch {
      return []
    }
  }

  return {
    async extract(history, existing) {
      const historyText = buildHistoryText(history)
      if (!historyText) return []
      const userText = m.memoryAuto.extractTask(historyText, formatExisting(existing))
      return runAgainstTool(m.memoryAuto.extractSystem(), userText)
    },
    async consolidate(existing) {
      const existingText = formatExisting(existing)
      if (!existingText) return []
      const userText = m.memoryAuto.consolidateTask(existingText)
      return runAgainstTool(m.memoryAuto.consolidateSystem(), userText)
    },
  }
}
