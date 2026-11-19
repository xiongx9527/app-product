/**
 * 试点 skill：偏好句「问一句再记」。
 *
 * 从 voiceSessionService 迁出的业务规则（原来散落在 pendingMemory +
 * tryMemoryConfirm/detectAndStagePreference/maybeAskMemoryConfirm + 同链追问 +
 * cancel/end 清空）。行为完全一致：
 *  - 用户说「我喜欢 X」：先正常回答，暂存为待确认（asked=false）；
 *  - LLM 回答收尾时把「要我帮你记下来吗？」拼进同一 TTS 链（无停顿），置 asked=true；
 *  - 用户下一句肯定 → 分类/合并后落库并口播确认；否定 → 口播不记；都不消费给 LLM；
 *  - 既非肯定也非否定 → 保留 pending，照常走对话；
 *  - 播完后兜底再问一次（asked 已 true 时自然 no-op）；
 *  - 会话取消/结束/重武装 → 清状态，不跨会话串味。
 *
 * 状态在该 skill 实例的闭包里，按会话隔离——这就是做成 skill 的价值：规则自带状态，
 * 不再把 pendingMemory 塞进 voiceSessionService 的字段。
 */
import { messages } from '../../../i18n'
import {
  detectPreference,
  isAffirmative,
  isNegative,
  mergeMemoryValue,
} from '../../control/memoryPrompt'
import type { Skill, SkillContext, SkillModule } from '../types'

/** LLM 抽取不可用/归不出来时的兜底 key（存储约定，非业务词表）。 */
const FALLBACK_MEMORY_KEY = '偏好'

interface PendingMemory {
  value: string
  asked: boolean
}

function createPreferenceSkill(ctx: SkillContext): Skill {
  let pending: PendingMemory | null = null

  return {
    async onFinalize(text) {
      // 只在已问过（asked=true，即有上下文）时才把肯定/否定当成对「要不要记」的回答。
      // 绝不因超时清 pending——隔十几秒的「好的」也要能对上。
      if (pending && pending.asked) {
        const emitFinal = () =>
          ctx.send({ type: 'asr.final', text, queueRemaining: ctx.queueRemaining() })

        if (isAffirmative(text)) {
          const value = pending.value
          pending = null
          emitFinal()
          // 归类完全交给 LLM 抽取引擎（它本就产出 {key,value}）；不再用词表硬编码分类。
          // 抽取不可用 / 归不出来 → 用兜底 key 原样存，绝不丢数据。
          let key = FALLBACK_MEMORY_KEY
          let finalValue = value
          if (ctx.agent && ctx.memoryStore) {
            try {
              const existing = await ctx.memoryStore.list()
              const extracted = (await ctx.agent.extractMemories([value], existing)) ?? []
              if (extracted.length > 0) {
                key = extracted[0].key
                finalValue = extracted[0].value
              }
            } catch { /* LLM 抽取失败：用兜底 key 原样存 */ }
          }
          // 相似记忆合并更新（同 key 去重），不是覆盖。
          let merged = finalValue
          if (ctx.memoryStore) {
            try {
              const list = await ctx.memoryStore.list()
              const same = list.find((e) => e.key === key)
              merged = mergeMemoryValue(same?.value, finalValue)
            } catch { /* 读失败就用新值直存 */ }
          }
          if (ctx.deviceId) await ctx.data.saveMemory(ctx.deviceId, key, merged)
          await ctx.speak(messages(ctx.lang).memory.rememberedSimple(merged))
          return { consumed: true }
        }

        if (isNegative(text)) {
          pending = null
          emitFinal()
          await ctx.speak(messages(ctx.lang).memory.notRemembered())
          return { consumed: true }
        }
        // 既非肯定也非否定：保留 pending，不消费，让句子走正常对话。
      }

      // 新偏好句：暂存为待确认（不消费、不口播提问——让 LLM 先正常回答）。
      if (ctx.deviceId && ctx.memoryStore && !pending) {
        const pref = detectPreference(text)
        if (pref) pending = { value: pref, asked: false }
      }
      return { consumed: false }
    },

    onAgentReply(_text, _full) {
      // pending && !asked → 把追问拼进同一 TTS 链，置 asked=true 建立确认上下文。
      // 这是「无停顿追问」的主路径，不能漏。
      if (pending && !pending.asked) {
        pending.asked = true
        return { appendTts: messages(ctx.lang).memory.askRemember() }
      }
      return undefined
    },

    async onAfterSpeak() {
      // 兜底追问：同链追问没走到时（如整句被不可念兜底替换），播完后再问一次。
      // asked 已 true 时 no-op。
      if (pending && !pending.asked) {
        pending.asked = true
        await ctx.speak(messages(ctx.lang).memory.askRemember())
      }
    },

    onSessionReset() {
      pending = null
    },
  }
}

export const preferenceSkill: SkillModule = {
  id: 'preference',
  name: '偏好记忆确认',
  // skill 提示词：只描述「你拥有这个能力」，不写「遇到喜欢就反问」这类硬规则——
  // 具体追问时机与确认判定由生命周期钩子确定性处理，提示词不掺业务分支。
  description: (lang) =>
    lang.toLowerCase().startsWith('en')
      ? 'You can remember the user’s personal preferences and habits. After a natural reply, a separate confirmation asks whether to save it; a later affirmative stores it and a negative discards it. Keep the chat natural and never promise “I remembered it” yourself.'
      : '你拥有「记住用户个人偏好和习惯」的能力。用户表达喜好后你先自然聊天，系统会另行确认要不要记下来，用户之后再肯定或否定才决定保存或放弃；你自己不要抢先说「记住了」。',
  create: createPreferenceSkill,
}
