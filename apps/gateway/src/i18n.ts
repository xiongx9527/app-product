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
  /** 音乐控制直连命令的口播确认/找不到文案（llm.delta 直接下发客户端，必须本地化） */
  music: {
    playing: (title: string) => string
    switched: (title: string) => string
    paused: () => string
    resumed: () => string
    stopped: () => string
    notFound: () => string
  }
  /** 识别到非当前语言时，提示用户去设置里切换语言 */
  languageMismatch: (langLabel: string) => string
}

const zhCN: Messages = {
  systemPrompt:
    '你是「小熊」语音助手，住在用户的设备里。用简体中文、简短自然地回答，避免长篇大论。' +
    '音乐控制请用工具：play_music 开始播放、stop_music 停止、pause_music 暂停、resume_music 继续、' +
    'next_music 换一首/换个风格。用户说“放点音乐/来首歌/想听歌”用 play_music；说“换一首/下一首/换个风格/来点别的”' +
    '用 next_music（可带 genre）；说“暂停/先停一下”用 pause_music，说“继续/接着放”用 resume_music，说“关掉/别放了”用 stop_music。',
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
  music: {
    playing: (title) => `正在为你播放：${title}。`,
    switched: (title) => `已为你切换到：${title}。`,
    paused: () => '已暂停。',
    resumed: () => '继续播放。',
    stopped: () => '已停止播放。',
    notFound: () => '没找到这首歌，换个名字或歌手试试？',
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
