import type { Lang, ServerErrorCode } from './protocol'

/**
 * 后端文案目录（国际化）。网关下发给客户端的所有可见文案都按 `lang` 从这里取，
 * 禁止在代码里硬编码中文。新增语言时在这里加一个 catalog 即可。
 */
export interface Messages {
  systemPrompt: string
  /** 当前正在播放的曲目上下文：拼进系统提示，让助手能回答「现在播的什么、谁的作品」。 */
  nowPlayingContext: (title: string, artist?: string, contentType?: string) => string
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
    /**
     * 没找到时的口播。spoken=true 表示用户要的是评书/相声这类内容而不是歌曲，
     * 措辞不能叫「这首歌」——否则用户会以为系统把他的话当成了点歌。
     */
    notFound: (spoken?: boolean) => string
    /** 占位播放源尚未实现：明确告知用户该源暂不可用，并引导改用百度搜索。入参是源 kind（代码值），展示名由 i18n 解析 */
    notImplemented: (kind: string) => string
    /** 多候选时口播编号列表，让用户用语音选「第几首」或直接说歌名 */
    candidates: (items: readonly string[]) => string
    /** 让用户选择的引导语 */
    chooseHint: () => string
    /** 没识别出用户选了哪首时的重问 */
    chooseAgain: () => string
    /** 推荐意图：列出候选让用户选，绝不自动播放 */
    recommend: (items: readonly string[]) => string
    /** 推荐但没具体歌手/风格：引导补充，不擅自乱播 */
    recommendPrompt: () => string
    /** 语音「换一首」找不到同类型的其它歌时，把选择权交给用户：自动换其它风格，或自己点名 */
    offerOtherType: () => string
    /** 换一首（按钮/语音确认后）退回其它风格并口播一句（不静默、也不追问） */
    switchedOther: () => string
    /** 循环播放：count 为总共播放的遍数（>1 才真循环，1 表示重播一遍） */
    looping: (count: number) => string
    /** 「循环播放」指令下发时没有正在播的曲子 */
    loopNothing: () => string
    /** 音量设到绝对值（pct 为目标百分比） */
    volumeSet: (pct: number) => string
    /** 音量调大后口播（pct 为调整后百分比） */
    volumeUp: (pct: number) => string
    /** 音量调小后口播（pct 为调整后百分比） */
    volumeDown: (pct: number) => string
    /** 已到最大还让调大 */
    volumeMax: () => string
    /** 已到最小还让调小 */
    volumeMin: () => string
    /** 语音「关闭字幕」后口播 */
    subtitleOff: () => string
    /** 语音「开启字幕」且有字幕：口播确认 */
    subtitleOn: () => string
    /** 语音「开启字幕」但当前曲无同源字幕：如实说没有，不乱称已显示 */
    subtitleNone: () => string
    /** 语音「关闭字幕」但当前本就没有字幕：如实说没有，不谎称已关闭 */
    subtitleNoActive: () => string
    /** 语音「暂停/继续/停止」但当前没在播放：如实说没有，不乱称已操作 */
    musicNotPlaying: () => string
    /** 语音切换播放模式：切到悬浮 */
    playModeFloat: () => string
    /** 语音切换播放模式：切回播放器 */
    playModePlayer: () => string
    /** 语音切换播放模式：只说切换（客户端自行 toggle） */
    playModeToggled: () => string
  }
  /** 商品/好价查询：编号列表话术、选择引导、选中后一句确认（不复述商品内容） */
  deals: {
    /** items 为编号后的商品标题；措辞用「第X件」不用「首」 */
    candidates: (items: readonly string[]) => string
    /** 让用户说编号的引导 */
    chooseHint: () => string
    /** 选中第 n 件后的一句确认；详情只走 media.detail 展示，不进 TTS */
    detailIntro: (n: number) => string
    /** 详情字段的统一 label：网关本地化后随 fields[] 下发，客户端不认识具体字段名 */
    fieldLabels: {
      price: () => string
      mall: () => string
      brand: () => string
      tags: () => string
      desc: () => string
      time: () => string
      source: () => string
    }
  }
  /** 数据来源展示名（按 lang 本地化）：值由数据源给 sourceKey，网关查表，客户端不认识 key。 */
  sources: Record<string, string>
  /** 开源工具/项目：选中后一句确认 + 详情字段 label（列表话术由工具自身产出） */
  opensource: {
    detailIntro: (n: number) => string
    fieldLabels: {
      tagline: () => string
      language: () => string
      os: () => string
      desc: () => string
      time: () => string
      source: () => string
      license: () => string
    }
  }
  /** 识别到非当前语言时，提示用户去设置里切换语言 */
  languageMismatch: (langLabel: string) => string
  /** 大模型整句都不可念（泄漏控制符 / 空回复 / 只剩符号）时的兜底口播：不念垃圾，给一句让人能重说的 */
  llmFallthrough: () => string
  /** 长期记忆：把该设备已记住的内容注入系统提示，让助手「知道你的习惯」 */
  memory: {
    /** items 是已格式化的「- 话题：内容」清单；空串表示还没记忆 */
    context: (items: string) => string
    /** 语音「记住XX」命中后口播：key 话题，value 内容 */
    remembered: (key: string, value: string) => string
    /** 语音「忘了XX」命中后口播：topic 话题，n 删除条数 */
    forgot: (topic: string, n: number) => string
    /** 清空全部记忆后口播 */
    cleared: () => string
    /** 没匹配到任何记忆时口播 */
    nothingToForget: () => string
  }
}

/** 播放源 kind → 各语言展示名（与客户端 settings.playback.* i18n 保持一致）。kind 是代码值，展示名集中在此处与客户端两侧对齐 */
const SOURCE_DISPLAY: Record<string, Record<string, string>> = {
  baidu: { 'zh-CN': '百度搜索', en: 'Baidu Search' },
}

/** 按 lang 解析播放源展示名；未知 kind 退化为 kind 本身，绝不硬编码中文展示名 */
function sourceDisplayName(kind: string, lang: string): string {
  return SOURCE_DISPLAY[kind]?.[lang] ?? SOURCE_DISPLAY[kind]?.['zh-CN'] ?? kind
}

const zhCN: Messages = {
  systemPrompt:
    '你是「小熊」语音助手，住在用户的设备里。用简体中文、简短自然地回答，避免长篇大论。' +
    '音乐控制请用工具：play_music 开始播放、stop_music 停止、pause_music 暂停、resume_music 继续、' +
    'next_music 换一首/换个风格。用户说“放点音乐/来首歌/想听歌”用 play_music；说“换一首/下一首/换个风格/来点别的”' +
    '用 next_music（可带 genre）；说“暂停/先停一下”用 pause_music，说“继续/接着放”用 resume_music，说“关掉/别放了”用 stop_music。' +
    '查询或推荐开源工具/软件/项目统一用 query_opensource：「开源」「开源项目」「开源工具」「开源数据库」「开源XXX」等说法，' +
    '以及「有什么好的数据库」「推荐个 AI 工具」「大数据用什么框架」这类找工具软件的求推荐，都调用它、用开源项目回答，不要凭记忆罗列；' +
    '结果要按 1、2、3、4 逐条念出编号，并提示用户可说编号选择，方便用户回「第2个」；用户回编号时结合上一轮列表回答那一项，不要重新查询、也不要当成点歌。' +
    '纯知识问答（如「数据库是什么」）才不调用。' +
    '【输出与表达约束】只输出纯文本，禁止任何 Markdown / 格式符号（' +
    '**加粗**、# 标题、列表符号、表格、代码块等）。禁止在调用工具（尤其是音乐工具）前后' +
    '说铺垫废话或道歉（如“好的”“稍等”“对不起，出现…”“让我看看”“Skipping…”之类），' +
    '直接调用工具或给一句最简短的回复即可。全程使用简体中文，不要中英混排。',
  nowPlayingContext: (title, artist, contentType) => {
    const kind = contentType ? contentType : '内容'
    return (
      `【当前正在播放】${kind}《${title}》${artist ? `（${artist}）` : ''}。` +
      '若用户问起正在播放的是什么（歌/电视/电影/动画/相声/评书等）、叫什么名字、是谁的作品（演唱/演出/导演等），' +
      '请直接据此回答，不要说不知道；没有标注创作者时只回答已知的名字，不要编造。'
    )
  },
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
    notFound: (spoken) =>
      spoken
        ? '没找到这段内容，换个名字试试？'
        : '没找到这首歌，换个名字或歌手试试？',
    /** 占位播放源尚未实现：明确告知用户该源暂不可用，并引导改用百度搜索，绝不伪装成「没找到这首歌」 */
    notImplemented: (kind) =>
      `播放源「${sourceDisplayName(kind, 'zh-CN')}」尚未实现，暂不可用，请到设置里改用「${sourceDisplayName('baidu', 'zh-CN')}」。`,
    candidates: (items) =>
      `找到几首：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}首，${it}`).join('；')}。`,
    chooseHint: () => '你想听第几首，或者说出歌名？',
    chooseAgain: () => '没听清选哪首，请说第几首或歌名。',
    /** 推荐意图：列出候选让用户选，绝不自动播放 */
    recommend: (items: readonly string[]) =>
      `为你推荐：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}首，${it}`).join('；')}。`,
    /** 推荐但没具体歌手/风格：引导补充，不擅自乱播 */
    recommendPrompt: () => '想听点什么风格，或者告诉我歌手，我帮你挑几首？',
    /** 换内容找不到同类型的其它内容时，把选择权交给用户（措辞对歌曲/评书/戏曲通用，不说「歌」） */
    offerOtherType: () =>
      '没找到同类型的其它内容，要我直接换点别的，还是你自己点名想听的？',
    /** 换内容（按钮/语音确认后）退回其它内容并口播一句（不静默、也不追问） */
    switchedOther: () => '没找到同类型的其它内容，给你换点别的。',
    /** 循环播放：count 为总共播放的遍数（>1 才真循环，1 表示重播一遍） */
    looping: (count) =>
      count > 1 ? `为你循环播放 ${count} 遍。` : '为你重播一遍。',
    /** 「循环播放」指令下发时没有正在播的曲子 */
    loopNothing: () => '现在还没在播放什么，先放一首再让我循环吧。',
    /** 音量设到绝对值 */
    volumeSet: (pct) => `已为您将音量调到 ${pct}%。`,
    /** 音量调大 */
    volumeUp: (pct) => `已调大，当前音量 ${pct}%。`,
    /** 音量调小 */
    volumeDown: (pct) => `已调小，当前音量 ${pct}%。`,
    /** 已到最大还让调大 */
    volumeMax: () => '音量已经最大了。',
    /** 已到最小还让调小 */
    volumeMin: () => '音量已经最小了。',
    /** 语音「关闭字幕」后口播 */
    subtitleOff: () => '已关闭字幕。',
    /** 语音「开启字幕」且有歌词：口播确认 */
    subtitleOn: () => '已开启字幕。',
    /** 语音「开启字幕」但当前曲没有同源字幕：如实说没有，不乱称已显示 */
    subtitleNone: () => '这首歌没有字幕，先给你开着，下一首有就自动显示。',
    /** 语音「关闭字幕」但当前本就没有字幕：如实说没有，不谎称已关闭 */
    subtitleNoActive: () => '当前没有字幕，本来就是关着的。',
    /** 语音「暂停/继续/停止」但当前没在播放：如实说没有，不乱称已操作 */
    musicNotPlaying: () => '现在还没在播放什么，先放一首吧。',
    playModeFloat: () => '已切换到悬浮模式。',
    playModePlayer: () => '已切换到播放器模式。',
    playModeToggled: () => '已切换播放模式。',
  },
  deals: {
    candidates: (items) =>
      `查到几件：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}件，${it}`).join('；')}。`,
    chooseHint: () => '你想看第几件，直接说编号就行。',
    detailIntro: (n) => `已为你打开第 ${n} 件商品详情，请看屏幕。`,
    fieldLabels: {
      price: () => '现价',
      mall: () => '商城',
      brand: () => '品牌',
      tags: () => '优惠',
      desc: () => '优惠详情',
      time: () => '发布时间',
      source: () => '来源',
    },
  },
  sources: { smzdm: '什么值得买', oschina: '开源中国', github: 'GitHub', gitee: 'Gitee' },
  opensource: {
    detailIntro: (n) => `已为你打开第 ${n} 个开源项目，请看屏幕。`,
    fieldLabels: {
      tagline: () => '定位',
      language: () => '开发语言',
      license: () => '开源协议',
      os: () => '系统',
      desc: () => '简介',
      time: () => '收录时间',
      source: () => '来源',
    },
  },
  languageMismatch: (langLabel) => `当前只识别${langLabel}，这句没有接收；如需用别的语言，请到设置里切换`,
  llmFallthrough: () => '抱歉，我刚才没反应过来，能再说一遍吗？',
  memory: {
    context: (items) =>
      items
        ? '\n\n以下是关于这位用户长期记住的信息（习惯 / 偏好 / 作息 / 日程等），回答时自然参考，不要逐条复述：\n' +
          items
        : '',
    remembered: (key, value) => `已记住：${key} —— ${value}。`,
    forgot: (topic, n) => `已忘掉关于「${topic}」的 ${n} 条记忆。`,
    cleared: () => '已清空关于你的全部记忆。',
    nothingToForget: () => '没找到匹配的，没什么可忘的。',
  },
}

/**
 * 英文目录：音乐口播等其余文案先复用中文（按用户要求暂不动），
 * 只把喂给模型的 systemPrompt 国际化，让英文会话收到英文指令。
 */
const en: Messages = {
  ...zhCN,
  systemPrompt:
    'You are «XiongXiong», a voice assistant living inside the user\'s device. ' +
    'Reply concisely and naturally in English, avoiding long-winded answers. ' +
    'Use tools for music control: play_music to start, stop_music to stop, ' +
    'pause_music to pause, resume_music to resume, next_music to switch to another track / style. ' +
    'When the user says "play some music / a song / I want to listen to music", use play_music; ' +
    'when they say "next one / another / a different style / something else", use next_music (genre optional); ' +
    'pause_music for "pause / hold on", resume_music for "resume / keep going", stop_music for "stop / turn it off". ' +
    'Use query_opensource for all open-source tool/software/project lookups and recommendations: "open source / open-source projects / ' +
    'open-source tools / open-source databases / open-source XXX", or "any good databases", "recommend an AI tool", "big-data frameworks" — ' +
    'always call it and answer with open-source projects instead of listing from memory. Read the results out with numbers 1, 2, 3, 4 and invite the user to pick one by number; ' +
    'when they reply with an ordinal, answer from the previous list — do not query again or treat it as a song request. Only pure knowledge questions ("what is a database") should not. ' +
    '[Output & expression constraints] Output plain text only. No Markdown or formatting symbols ' +
    '(**bold**, # headings, list bullets, tables, code blocks, etc.). ' +
    'Do not add filler or apologies before or after calling a tool (especially music tools) — ' +
    'no "Sure", "Just a moment", "Sorry, ...", "Let me see", "Skipping...", etc. ' +
    'Call the tool directly or give the shortest possible reply. Always reply in English, no Chinese-English mixing.',
  nowPlayingContext: (title, artist, contentType) => {
    const kind = contentType ? contentType : 'content'
    return (
      `[Now playing] ${kind} "${title}"${artist ? ` (${artist})` : ''}. ` +
      'If the user asks what is playing (song/TV/movie/anime/crosstalk/audiobook…), its name, or who made it ' +
      '(singer/performer/director…), answer directly from this; do not say you don\'t know. ' +
      'If no creator is given, only name the title and do not invent one.'
    )
  },
  // 占位播放源提示：英文会话也要拿到本地化展示名与英文文案，不残留中文
  music: {
    ...zhCN.music,
    notImplemented: (kind) =>
      `The music source "${sourceDisplayName(kind, 'en')}" is not yet available. Please switch to "${sourceDisplayName('baidu', 'en')}" in settings.`,
    subtitleOff: () => 'Subtitles off.',
    subtitleOn: () => 'Subtitles on.',
    subtitleNone: () => 'No subtitles for this track. I\'ve turned them on, and they\'ll show automatically when the next one has them.',
    subtitleNoActive: () => 'There are no subtitles currently — they\'re already off.',
    musicNotPlaying: () => 'Nothing is playing right now; play something first.',
    offerOtherType: () =>
      'No other content of the same type found. Shall I switch to something else, or would you name one?',
    switchedOther: () => 'No other content of the same type found; switching to something else.',
    playModeFloat: () => 'Switched to floating mode.',
    playModePlayer: () => 'Switched to player mode.',
    playModeToggled: () => 'Playback mode switched.',
  },
  deals: {
    ...zhCN.deals,
    candidates: (items) =>
      `Found some items: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one? Just say the number.',
    detailIntro: (n) => `Opened item ${n} on screen.`,
    fieldLabels: {
      price: () => 'Price',
      mall: () => 'Store',
      brand: () => 'Brand',
      tags: () => 'Tags',
      desc: () => 'Details',
      time: () => 'Posted',
      source: () => 'Source',
    },
  },
  sources: { smzdm: 'SMZDM', oschina: 'OSCHINA', github: 'GitHub', gitee: 'Gitee' },
  opensource: {
    detailIntro: (n) => `Opened project ${n} on screen.`,
    fieldLabels: {
      tagline: () => 'Tagline',
      language: () => 'Language',
      license: () => 'License',
      os: () => 'Platform',
      desc: () => 'Summary',
      time: () => 'Added',
      source: () => 'Source',
    },
  },
}

const catalogs: Record<string, Messages> = {
  'zh-CN': zhCN,
  en,
}

export function messages(lang: Lang | string = 'zh-CN'): Messages {
  if (catalogs[lang]) return catalogs[lang]
  // 客户端可能上报带地区的语言码（en-US / en_GB / zh-TW），按语言前缀回退，
  // 否则精确匹配失败会整体退回中文——下发给英文用户的文案会变成中文。
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return catalogs[prefix] ?? zhCN
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
