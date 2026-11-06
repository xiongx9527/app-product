import type { Lang, ServerErrorCode } from './protocol'

/**
 * 后端文案目录（国际化）。网关下发给客户端的所有可见文案都按 `lang` 从这里取，
 * 禁止在代码里硬编码中文。新增语言时在这里加一个 catalog 即可。
 */
export interface Messages {
  systemPrompt: string
  errors: Record<ServerErrorCode, string>
  /** 排队提示与拒绝原因，按 lang 本地化后下发给客户端展示 */
  queue: {
    accepted: (position: number, size: number) => string
    full: () => string
  }
  /** 识别到非当前语言时，提示用户去设置里切换语言 */
  languageMismatch: (langLabel: string) => string
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
  queue: {
    accepted: (position, size) => `已排到第 ${position} 句（共 ${size} 句），当前回答播完就处理`,
    full: () => '你说的太多了，我记不住。',
  },
  languageMismatch: (langLabel) => `当前只识别${langLabel}，这句没有接收；如需用别的语言，请到设置里切换`,
}

const catalogs: Record<string, Messages> = {
  'zh-CN': zhCN,
}

export function messages(lang: Lang | string = 'zh-CN'): Messages {
  return catalogs[lang] ?? zhCN
}

/** 语言代码 → 当前会话文案里的可读名称，用于「请切换语言」提示。 */
const LANGUAGE_LABELS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  ru: '俄文',
}

export function languageLabel(lang: string): string {
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return LANGUAGE_LABELS[prefix] ?? lang
}
