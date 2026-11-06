import type { Lang, ServerErrorCode } from './protocol'

/**
 * 后端文案目录（国际化）。网关下发给客户端的所有可见文案都按 `lang` 从这里取，
 * 禁止在代码里硬编码中文。新增语言时在这里加一个 catalog 即可。
 */
export interface Messages {
  systemPrompt: string
  errors: Record<ServerErrorCode, string>
}

const zhCN: Messages = {
  systemPrompt: '你是「小熊」语音助手，住在用户的设备里。用简体中文、简短自然地回答，避免长篇大论。',
  errors: {
    AUTH_FAILED: '鉴权失败，请重新登录',
    ASR_TIMEOUT: '识别超时',
    LLM_ERROR: '模型异常',
    RATE_LIMITED: '请求过于频繁，请稍后再试',
    SESSION_CLOSED: '会话已关闭',
  },
}

const catalogs: Record<string, Messages> = {
  'zh-CN': zhCN,
}

export function messages(lang: Lang | string = 'zh-CN'): Messages {
  return catalogs[lang] ?? zhCN
}
