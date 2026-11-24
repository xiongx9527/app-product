/**
 * 通用「详情反问介绍」skill（不绑死任何业务类型）。
 *
 * 任何结构化详情（商品 deals / 开源项目 project / 未来的产品介绍等）打开后：
 *  - 收到 onDetailOpen（网关在 client.detail 或 media.detail(selectedIndex) 时统一广播）：
 *    反问一句「要不要我帮你介绍下这个？」（ctx.speak，确定性、零额外 LLM 调用），记住待确认状态；
 *  - 用户下一句经 onIntroConfirm（高优先级，先于 preference 等 skill 消费）：
 *    肯定 → 让 LLM 基于已注入 systemPrompt 的详情字段介绍（agent.reply → speak）；
 *    否定 → 口播「那就不介绍了」；都不消费给普通对话路径。
 *  - 关闭详情 / 换商品 / 会话结束时清状态。
 *
 * 本 skill 只认通用 DetailContext（kind + title + fields），不 import 任何业务类型。
 * 业务 skill 零改动即获得此能力——它只管发 media.detail，网关包装 send 自动广播 onDetailOpen。
 */
import { messages } from '../../../i18n'
import { isConfirmYes, isConfirmNo } from '../confirm'
import type { DetailContext } from '../../../protocol'
import type { Skill, SkillContext, SkillModule } from '../types'

interface AwaitingIntro {
  detail: DetailContext
  asked: boolean
}

function createDetailChatSkill(ctx: SkillContext): Skill {
  let awaiting: AwaitingIntro | null = null

  const reset = () => { awaiting = null }

  return {
    async onDetailOpen(detail) {
      // 打开一条新详情：先清掉上一条的待确认/介绍状态，再反问。
      reset()
      awaiting = { detail, asked: false }
      try {
        await ctx.speak(messages(ctx.lang).detail.askIntro())
        awaiting.asked = true
      } catch {
        // 反问口播失败就放弃这次待确认，不卡住用户
        reset()
      }
    },

    async onDetailClose() {
      // 详情关闭：清掉待确认与介绍态；详情上下文本身由网关核心清除。
      reset()
    },

    async onIntroConfirm(text) {
      if (!awaiting || !awaiting.asked) return undefined
      const emitFinal = () =>
        ctx.send({ type: 'asr.final', text, queueRemaining: ctx.queueRemaining() })

      if (isConfirmYes(text)) {
        awaiting = null
        emitFinal()
        const m = messages(ctx.lang).detail
        if (ctx.agent) {
          try {
            let intro = ''
            // 详情字段已由 detailContext 注入 systemPrompt，此处只给一句指令让 LLM 基于它介绍。
            await ctx.agent.reply(m.introHint(), (delta) => { intro += delta })
            const trimmed = intro.trim()
            if (trimmed) await ctx.speak(trimmed)
          } catch {
            // LLM 介绍失败不卡死：静默，用户仍可继续问（详情上下文还在）
          }
        }
        return { consumed: true }
      }

      if (isConfirmNo(text)) {
        awaiting = null
        emitFinal()
        await ctx.speak(messages(ctx.lang).detail.declineIntro())
        return { consumed: true }
      }

      // 既非肯定也非否定：保留待确认状态，照常走对话（用户可能在问别的）。
      return undefined
    },

    onSessionReset() {
      reset()
    },
  }
}

export const detailChatSkill: SkillModule = {
  id: 'detailChat',
  name: '通用详情反问介绍',
  // 不参与直连意图/裸查询，priority 仅影响注册顺序；给一个不冲突的值。
  priority: 15,
  // 提示词：让 LLM 知道系统会在打开详情时另行反问，它自己不要抢着问；
  // 确认后或被问及当前详情时，基于已注入的详情字段介绍，不编造。
  description: (lang) =>
    lang.toLowerCase().startsWith('en')
      ? 'When a detail card is open, the system asks whether you should introduce it; never ask that yourself. If the user agrees or asks about the current item, introduce/chat using only the detail fields provided in your context. Do not invent information.'
      : '打开详情卡片后，系统会另行询问用户要不要介绍，你绝对不要自己反问「要不要介绍」。用户同意或问及当前详情时，只基于上下文里给出的详情字段介绍、聊天，不要编造字段外的内容。',
  create: createDetailChatSkill,
}
