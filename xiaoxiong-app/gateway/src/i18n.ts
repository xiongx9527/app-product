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
    /** 多候选时口播编号列表，让用户用语音选「第几首」或直接说歌名 */
    candidates: (items: readonly string[]) => string
    /** 让用户选择的引导语 */
    chooseHint: () => string
    /** 没识别出用户选了哪首时的重问 */
    chooseAgain: () => string
  }
  /** 识别到非当前语言时，提示用户去设置里切换语言 */
  languageMismatch: (langLabel: string) => string
  /** 长期记忆：把该设备已记住的内容注入系统提示，让助手「知道你的习惯」 */
  memory: {
    /** items 是已格式化的「- 话题：内容」清单；空串表示还没记忆 */
    context: (items: string) => string
    /** 语音「忘了XX」命中后口播：topic 话题，n 删除条数 */
    forgot: (topic: string, n: number) => string
    /** 清空全部记忆后口播 */
    cleared: () => string
    /** 没匹配到任何记忆时口播 */
    nothingToForget: () => string
  }
}

const zhCN: Messages = {
  systemPrompt:
    '你是「小熊」语音助手，住在用户的设备里。用简体中文、简短自然地回答，避免长篇大论。' +
    '音乐控制请用工具：play_music 开始播放、stop_music 停止、pause_music 暂停、resume_music 继续、' +
    'next_music 换一首/换个风格。用户说“放点音乐/来首歌/想听歌”用 play_music；说“换一首/下一首/换个风格/来点别的”' +
    '用 next_music（可带 genre）；说“暂停/先停一下”用 pause_music，说“继续/接着放”用 resume_music，说“关掉/别放了”用 stop_music。' +
    '【输出与表达约束】只输出纯文本，禁止任何 Markdown / 格式符号（' +
    '**加粗**、# 标题、列表符号、表格、代码块等）。禁止在调用工具（尤其是音乐工具）前后' +
    '说铺垫废话或道歉（如“好的”“稍等”“对不起，出现…”“让我看看”“Skipping…”之类），' +
    '直接调用工具或给一句最简短的回复即可。全程使用简体中文，不要中英混排。',
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
    candidates: (items) =>
      `找到几首：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}首，${it}`).join('；')}。`,
    chooseHint: () => '你想听第几首，或者说出歌名？',
    chooseAgain: () => '没听清选哪首，请说第几首或歌名。',
  },
  languageMismatch: (langLabel) => `当前只识别${langLabel}，这句没有接收；如需用别的语言，请到设置里切换`,
  memory: {
    context: (items) =>
      items
        ? '\n\n以下是关于这位用户长期记住的信息（习惯 / 偏好 / 作息 / 日程等），回答时自然参考，不要逐条复述：\n' +
          items
        : '',
    forgot: (topic, n) => `已忘掉关于「${topic}」的 ${n} 条记忆。`,
    cleared: () => '已清空关于你的全部记忆。',
    nothingToForget: () => '没找到匹配的，没什么可忘的。',
  },
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
