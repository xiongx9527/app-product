import type { AssistantEffect, AssistantEvent, AssistantState } from './types'

export interface TransitionResult {
  state: AssistantState
  effects: AssistantEffect[]
}

const NOOP = (state: AssistantState): TransitionResult => ({ state, effects: [] })

/**
 * 纯状态机：不碰定时器、不碰音频、不碰网络。
 * 好处是可单测，也方便以后把同一套逻辑复用到别的端。
 */
export function transition(
  state: AssistantState,
  event: AssistantEvent
): TransitionResult {
  switch (event.type) {
    case 'ENABLE':
      if (state !== 'idle') return NOOP(state)
      return { state: 'standby', effects: ['startWake'] }

    case 'DISABLE':
      if (state === 'idle') return NOOP(state)
      return {
        state: 'idle',
        effects: ['cancelT1', 'cancelT2', 'cancelSession', 'stopWake'],
      }

    case 'WAKE':
      if (state !== 'standby') return NOOP(state)
      // 唤醒后先打招呼，让用户立刻知道“它醒了”，再开始静默计时
      return {
        state: 'listening',
        effects: ['startSession', 'playGreeting', 'scheduleT1'],
      }

    case 'REWAKE':
      // 对话进行中再次叫「小熊小熊」：视作重新唤醒。停掉当前轮次、重新招呼，
      // 回到干净的对听状态，不退回待唤醒（不必再说一次唤醒词）。
      if (state === 'listening' || state === 'confirming' || state === 'closing') {
        return {
          state: 'listening',
          effects: ['cancelT1', 'cancelT2', 'cancelSession', 'playGreeting', 'scheduleT1'],
        }
      }
      return NOOP(state)

    case 'USER_SPEECH':
      if (state === 'confirming') {
        // 用户回应了提示：取消退出，继续本轮
        return { state: 'listening', effects: ['cancelT2', 'scheduleT1'] }
      }
      if (state === 'listening') {
        // 用户还在说：重置静默计时
        return { state, effects: ['cancelT1', 'scheduleT1'] }
      }
      return NOOP(state)

    case 'ASSISTANT_BUSY':
      // 助手在思考/回答/播报，静默计时必须挂起：否则一句长回答还没说完就触发「还在吗」
      if (state !== 'listening') return NOOP(state)
      return { state, effects: ['cancelT1'] }

    case 'ASSISTANT_IDLE':
      // 本轮回答彻底结束，从这一刻重新开始算用户静默
      if (state !== 'listening') return NOOP(state)
      return { state, effects: ['scheduleT1'] }

    case 'T1_TIMEOUT':
      if (state !== 'listening') return NOOP(state)
      return {
        state: 'confirming',
        effects: ['cancelT1', 'playPrompt', 'scheduleT2'],
      }

    case 'T2_TIMEOUT':
      if (state !== 'confirming') return NOOP(state)
      return { state: 'closing', effects: ['cancelT2', 'playFarewell'] }

    case 'SESSION_DONE':
      if (state !== 'closing') return NOOP(state)
      // 退出本轮后回到待唤醒，随时可以再次唤醒
      return { state: 'standby', effects: ['endSession', 'startWake'] }

    case 'CANCEL':
      if (state === 'listening' || state === 'confirming') {
        return {
          state: 'standby',
          effects: ['cancelT1', 'cancelT2', 'cancelSession', 'startWake'],
        }
      }
      if (state === 'closing') {
        return { state: 'standby', effects: ['cancelT2', 'endSession', 'startWake'] }
      }
      return NOOP(state)

    case 'ERROR':
      if (state === 'standby' || state === 'idle') return NOOP(state)
      return {
        state: 'standby',
        effects: ['cancelT1', 'cancelT2', 'endSession', 'startWake'],
      }

    default:
      return NOOP(state)
  }
}
