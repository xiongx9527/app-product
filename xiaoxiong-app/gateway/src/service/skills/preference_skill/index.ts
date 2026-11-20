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
} from './memoryPrompt'
import { detectMemoryCommand } from './memoryControl'
import { classifyPreference } from './preferenceCategory'
import type { Skill, SkillContext, SkillModule } from '../types'

interface PendingMemory {
  value: string
  asked: boolean
}

function createPreferenceSkill(ctx: SkillContext): Skill {
  let pending: PendingMemory | null = null

  return {
    async onDirectCommand(text) {
      // 记忆直连命令（记住 XX / 忘了 XX / 清空记忆）：确定性落地，不进 LLM。
      // 只在句首有明确动词时命中（detectMemoryCommand 内部保证），不误伤「我忘了带钥匙」。
      const cmd = detectMemoryCommand(text)
      if (!cmd || !ctx.deviceId) return undefined
      const m = messages(ctx.lang).memory
      if (cmd.action === 'remember') {
        await ctx.data.saveMemory(ctx.deviceId, cmd.key, cmd.value)
        await ctx.speak(m.remembered(cmd.key, cmd.value))
        return { consumed: true }
      }
      if (cmd.action === 'clear') {
        await ctx.data.forgetMemory(ctx.deviceId)
        await ctx.speak(m.cleared())
        return { consumed: true }
      }
      const n = await ctx.data.forgetMemory(ctx.deviceId, cmd.topic)
      await ctx.speak(n > 0 ? m.forgot(cmd.topic, n) : m.nothingToForget())
      return { consumed: true }
    },
    matchesIntent(text) {
      return detectMemoryCommand(text) !== null
    },
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
          // 分类用确定性词表（苹果→饮食、乒乓球→运动…），不靠 LLM 抽 key——
          // 真机实测 LLM 把「喜欢打乒乓球」抽成「下来」，用户明确说分类不靠谱。
          const key = classifyPreference(value)
          const finalValue = value
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
  // 记忆直连命令（记住/忘了/清空）原在 handleDirectCommand 最前，故给最小 priority 保证先消费；
  // 偏好确认走 onFinalize/onAgentReply，与直连优先级无关。
  priority: 5,
  // skill 提示词：只描述「你拥有这个能力」，不写「遇到喜欢就反问」这类硬规则——
  // 具体追问时机与确认判定由生命周期钩子确定性处理，提示词不掺业务分支。
  // 明确禁止模型自己追问「要不要记」——否则代码拼的追问 + 模型自己问 = 两个问句，用户懵。
  description: (lang) =>
    lang.toLowerCase().startsWith('en')
      ? 'You can remember the user’s personal preferences and habits. After a natural reply, a separate confirmation asks whether to save it. NEVER ask the user whether to remember anything yourself — the system does that for you. Do not promise “I remembered it” yourself either; just reply naturally.'
      : '你拥有「记住用户个人偏好和习惯」的能力。用户表达喜好后你只管自然聊天、正常回答，系统会另行确认要不要记下来。你绝对不要自己问用户「要不要记下来/要我记住吗」之类的话——系统会自动问，避免重复追问让你困惑；你自己也不要抢先说「记住了」。',
  create: createPreferenceSkill,
}
