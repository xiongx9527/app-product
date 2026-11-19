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
  classifyPreference,
  mergeMemoryValue,
} from '../../control/memoryPrompt'
import type { Skill, SkillContext, SkillModule } from '../types'

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
          // 内置分类优先；通用「偏好」才交 LLM 抽取兜底；都失败原样存，绝不丢。
          let key = classifyPreference(value)
          let finalValue = value
          if (key === '偏好' && ctx.agent && ctx.memoryStore) {
            try {
              const existing = await ctx.memoryStore.list()
              const extracted = (await ctx.agent.extractMemories([value], existing)) ?? []
              if (extracted.length > 0) {
                key = extracted[0].key
                finalValue = extracted[0].value
              }
            } catch { /* LLM 抽取失败：用内置通用 key 原样存 */ }
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
  // 纯代码钩子型 skill：行为全靠生命周期钩子实现，不向 LLM 暴露提示词——
  // 否则「遇到喜欢就追问要不要记」又被写回 systemPrompt，违背「提示词不写死业务规则」。
  description: () => '',
  create: createPreferenceSkill,
}
