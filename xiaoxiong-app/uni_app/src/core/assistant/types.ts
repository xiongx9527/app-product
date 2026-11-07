/** 语音助手会话状态 */
export type AssistantState =
  | 'idle' // 总开关关闭 / 无权限
  | 'standby' // 待唤醒：本地常听，音频不上传
  | 'listening' // 对话中：上行音频，收文字与 TTS
  | 'confirming' // 静默提示中：等待用户回应
  | 'closing' // 结束本轮：播结束语，关闭会话

export type AssistantEvent =
  | { type: 'ENABLE' }
  | { type: 'DISABLE' }
  | { type: 'WAKE' }
  | { type: 'REWAKE' }
  | { type: 'USER_SPEECH' }
  | { type: 'ASSISTANT_BUSY' }
  | { type: 'ASSISTANT_IDLE' }
  | { type: 'T1_TIMEOUT' }
  | { type: 'T2_TIMEOUT' }
  | { type: 'SESSION_DONE' }
  | { type: 'CANCEL' }
  | { type: 'ERROR' }

/** 状态机只描述“该做什么”，具体由运行时执行 */
export type AssistantEffect =
  | 'startWake'
  | 'stopWake'
  | 'startSession'
  | 'endSession'
  | 'cancelSession'
  | 'scheduleT1'
  | 'cancelT1'
  | 'scheduleT2'
  | 'cancelT2'
  | 'playGreeting'
  | 'playPrompt'
  | 'playFarewell'

export interface AssistantConfig {
  /** 对话中连续静默多久后提示（毫秒） */
  t1SilenceMs: number
  /** 提示后等待用户回应的宽限时间（毫秒） */
  t2GraceMs: number
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  // 助手答完后，用户连续静默多久才问"还在吗？"。默认 30s，比 20s 更贴合人说话/思考的节奏，
  // 避免答完没多久就催问（用户反馈"还在吗？过的时间有些短"）。
  t1SilenceMs: 30_000,
  // 问完"还在吗？"后，给用户多久回应宽限才正式结束本轮。默认 15s。
  t2GraceMs: 15_000,
}

export const STATE_LABEL: Record<AssistantState, string> = {
  idle: '未开启',
  standby: '待唤醒',
  listening: '对话中',
  confirming: '等待回应',
  closing: '结束中',
}
