import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { MemoryEntry } from '../../service/dataService'

/**
 * 记忆读写接口（按当前设备维度，由 controller 用 DataService 包好 deviceId 注入）。
 * 工具层只认这个抽象，不直接碰 DataService，便于离线测试注入桩。
 */
export interface MemoryStore {
  /** 记住一条：key 是话题标签，value 是具体内容；同 key 覆盖更新。 */
  save(key: string, value: string): Promise<void>
  /** 读出该设备全部记忆（最新的在前）。 */
  list(): Promise<MemoryEntry[]>
  /** 遗忘：按话题/内容模糊匹配删除；空串表示清空全部。返回删除条数。 */
  forget(query?: string): Promise<number>
}

/** 单条记忆在「回忆」/系统提示里注入时的最大字符数，超出截断，避免污染上下文。 */
const VALUE_CAP = 80
/** 「回忆」一次最多带回的条目数（系统提示注入也受此约束）。 */
const MAX_ENTRIES = 50

function prefixOf(lang: Lang | string): string {
  return (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
}

/** 把记忆列表格式化成「key：value」清单，用于工具返回与系统提示注入。 */
export function formatMemories(entries: MemoryEntry[], max = MAX_ENTRIES): string {
  const picked = entries.slice(0, max)
  if (picked.length === 0) return ''
  return picked
    .map((e) => {
      const v = e.value.length > VALUE_CAP ? `${e.value.slice(0, VALUE_CAP)}…` : e.value
      return `- ${e.key}：${v}`
    })
    .join('\n')
}

/** 噪声过滤：太短/空泛的内容不值得长期记住，避免把闲聊堆进记忆。 */
function isWorthRemembering(key: string, value: string): boolean {
  const k = key.trim()
  const v = value.trim()
  if (!k || !v) return false
  // 内容过短（如单字、标点）几乎没有长期价值
  if (v.length < 2) return false
  return true
}

const REMEMBER_DESC: Record<string, string> = {
  zh: '记住关于这位用户的长期信息（习惯、偏好、作息、日程、重要的人/事/上下文）。只记录经用户明确表达、可长期复用的稳定事实，不要记一次性请求或闲聊。key 用简短话题标签（如「作息」「喜欢的音乐」「常去的地方」），同类信息用同一个 key 覆盖更新。若用户只是随口一说或临时需求，不要调用本工具。',
  en: 'Remember durable, long-term facts about this user (habits, preferences, routine, schedule, important people/context). Only store stable facts the user clearly expressed and that will be useful later; do not store one-off requests or chit-chat. Use a short topic label as key (e.g. "routine", "favorite music") and reuse the same key to update. Do not call this for transient needs.',
}

const RECALL_DESC: Record<string, string> = {
  zh: '回忆之前记住的关于这位用户的长期信息。当用户问「你还记得我……吗」「你了解我什么」「我上次说的……」或你需要参考用户习惯/偏好时调用，返回已记住的内容。',
  en: 'Recall previously remembered long-term facts about this user. Call when the user asks what you remember about them, or when you need their habits/preferences to answer well.',
}

const FORGET_DESC: Record<string, string> = {
  zh: '遗忘关于这位用户的某条记忆。当用户说「忘了XX」「忘记XX」「别记XX」「清除/清空记忆」时调用。topic 传要忘的话题或内容关键词（如「作息」「喜欢的食物」）；传空串表示清空全部记忆。',
  en: 'Forget a remembered fact about this user. Call when the user says "forget X", "don\'t remember X", or "clear my memory". Pass the topic/keyword to forget; pass empty string to clear all memories.',
}

/** 记住一条长期信息；噪声会被拒收并给出口语化说明。 */
export function createRememberTool(lang: Lang | string, store: MemoryStore) {
  const p = prefixOf(lang)
  return {
    name: 'remember',
    description: REMEMBER_DESC[p] ?? REMEMBER_DESC.zh,
    inputSchema: z.object({
      key: z.string().describe('话题标签，如 作息 / 喜欢的音乐 / 常去的地方'),
      value: z.string().describe('具体内容'),
    }),
    async call(args: { key: string; value: string }) {
      if (!isWorthRemembering(args?.key ?? '', args?.value ?? '')) {
        return p === 'en'
          ? 'That seems too trivial or unclear to remember; I will only store durable facts.'
          : '这个太零碎或说不清，我不记了；只记长期有用的习惯和偏好。'
      }
      await store.save(args.key, args.value)
      return p === 'en' ? `Got it, I'll remember: ${args.key} — ${args.value}.` : `好的，我记住了：${args.key} —— ${args.value}。`
    },
  }
}

/** 回忆全部记忆；空则如实告知。 */
export function createRecallTool(lang: Lang | string, store: MemoryStore) {
  const p = prefixOf(lang)
  return {
    name: 'recall',
    description: RECALL_DESC[p] ?? RECALL_DESC.zh,
    inputSchema: z.object({}),
    async call() {
      const entries = await store.list()
      if (entries.length === 0) {
        return p === 'en'
          ? 'I have not remembered anything about you yet.'
          : '我还没记住关于你的任何事。'
      }
      return `${p === 'en' ? 'What I remember about you:' : '我记得你这些：'}\n${formatMemories(entries)}`
    },
  }
}

/** 遗忘一条（或清空全部）记忆；返回删除条数。 */
export function createForgetTool(lang: Lang | string, store: MemoryStore) {
  const p = prefixOf(lang)
  return {
    name: 'forget',
    description: FORGET_DESC[p] ?? FORGET_DESC.zh,
    inputSchema: z.object({
      topic: z.string().optional().describe('要忘的话题/内容关键词；空串表示清空全部'),
    }),
    async call(args: { topic?: string }) {
      const n = await store.forget(args?.topic)
      if (n === 0) {
        return p === 'en'
          ? 'Nothing matched, so there was nothing to forget.'
          : '没找到匹配的，没什么可忘的。'
      }
      if (!args?.topic) {
        return p === 'en' ? 'Cleared all my memories about you.' : '已清空关于你的全部记忆。'
      }
      return p === 'en' ? `Forgot ${n} item(s) about "${args.topic}".` : `已忘掉关于「${args.topic}」的 ${n} 条记忆。`
    },
  }
}
