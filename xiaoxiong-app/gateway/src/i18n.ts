import type { Lang, ServerErrorCode } from './protocol'
// skill 自带文案：网关 i18n 只做汇总，文案本体跟 skill 走（避免 skill↔i18n 循环依赖：
// 这些片段文件是纯数据、不 import 本文件；skill 通过 messages().clock 取用）。
import { clockI18n, type ClockI18n } from './service/skills/time_skill/i18n'

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
  /** 时间/日期文案由 time_skill 自带（skills/time_skill/i18n.ts），经下方 catalogs 汇总进来 */
  clock: ClockI18n
  /** 择吉日直连口播：日期/宜忌串为固定中文（黄历数据 + lunar 算法产出），按 lang 拼句，不进大模型 */
  auspicious: {
    /** 带事项：activity 为口语事项（搬家/嫁娶），days 为「X月X日（星期X，农历X月X）」逗号串 */
    found: (activity: string, days: string) => string
    /** 泛吉日（没说事项）：days 为「X月X日（星期X，农历X月X，宜A、B）」串 */
    best: (days: string) => string
    /** 30 天都没找到宜该事项的日子 */
    none: (activity: string) => string
  }
  /** 大模型超时/不可用时的友好兜底：不让用户干等、也不暴露技术故障，按 lang 本地化 */
  llmUnavailable: () => string
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
    /** 像在报编号但没对上（含糊/听错/越界）时的重问；列表保留，不交给大模型 */
    chooseAgain: () => string
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
  /** 新闻播报：抓真实新闻视频、抽音轨播放；多条时列候选让用户语音选一条（同音乐选号）。 */
  news: {
    /** 播放器标题（media.play.title）；keyword 为话题词时带上话题 */
    title: (keyword?: string) => string
    /** 单条新闻开播时助手框的简短确认（无字幕，仅助手框显示） */
    playing: (title: string) => string
    /** 抓到 N 条新闻的引导；keyword 为话题词（带话题搜索），无话题词即泛播当日头条 */
    intro: (count: number, keyword?: string) => string
    /** 没查到新闻（抓到 0 条）；keyword 为话题词时说明是「与该话题相关」 */
    none: (keyword?: string) => string
    /** 抓取失败/网络不可达时的诚实兜底，不编造新闻 */
    unavailable: () => string
    /** 多条新闻视频候选：编号列出清洗后的标题（显示在助手框） */
    candidates: (items: readonly string[]) => string
    /** 让用户语音选一条的提示 */
    chooseHint: () => string
    /** 选号没听清时的重问 */
    chooseAgain: () => string
    /** 本批新闻播完后再说「下一条」：如实告知，引导重新抓一批 */
    noMore: () => string
  }
  /** 百科查询：抓真实百科词条摘要播报（音频来自百度百科）。无话题时提示用户说查谁。 */
  baike: {
    /** 纯「百科」无话题时的提示 */
    prompt: () => string
    /** 播报开始时在助手框显示的简短确认（同音乐 playing 风格，不显示全文） */
    playing: (title: string) => string
  }
  /** 数据来源展示名（按 lang 本地化）：值由数据源给 sourceKey，网关查表，客户端不认识 key。 */
  sources: Record<string, string>
  /** 大模型整句都不可念（泄漏控制符 / 空回复 / 只剩符号）时的兜底口播：不念垃圾，给一句让人能重说的 */
  llmFallthrough: () => string
  /** 长期记忆：把该设备已记住的内容注入系统提示，让助手「知道你的习惯」 */
  memory: {
    /** items 是已格式化的「- 话题：内容」清单；空串表示还没记忆 */
    context: (items: string) => string
    /** 语音「记住XX」命中后口播：key 话题，value 内容 */
    remembered: (key: string, value: string) => string
    rememberedSimple: (value: string) => string
    /** 语音「忘了XX」命中后口播：topic 话题，n 删除条数 */
    forgot: (topic: string, n: number) => string
    /** 清空全部记忆后口播 */
    cleared: () => string
    /** 没匹配到任何记忆时口播 */
    nothingToForget: () => string
    /** 检测到偏好后询问是否记入长期记忆 */
    askRemember: () => string
    /** 用户拒绝记录后的口播 */
    notRemembered: () => string
  }
  /** 自动记忆（自动抽取 + 摘要）：抽取引擎与合并引擎的提示词，按 lang 本地化后再喂给模型 */
  memoryAuto: {
    /** 抽取系统提示（静态，不随已有记忆变化） */
    extractSystem: () => string
    /** 抽取用户消息：history 为最近几句用户原话，existing 为已存记忆清单（空串表示还没有） */
    extractTask: (history: string, existing: string) => string
    /** 合并（摘要）系统提示（静态） */
    consolidateSystem: () => string
    /** 合并用户消息：existing 为当前全部记忆清单 */
    consolidateTask: (existing: string) => string
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
  // skill 自带文案汇总（clock 来自 time_skill）
  clock: clockI18n['zh-CN'],
  systemPrompt:
    '你是「小熊」语音助手，住在用户的设备里。用简体中文、言简意赅地回答：只说与问题直接相关的，不说废话、不铺垫、不重复、不讲无关的东西，但内容要点必须完整——' +
    '用户要求列举的（如「十大瞬间」「列出几项」）要逐条列全，不能因为精简而漏项或只答一部分。长度按内容需要决定，不设字数上限。' +
    '【输出与表达约束】只输出纯文本，禁止任何 Markdown / 格式符号（' +
    '**加粗**、# 标题、列表符号、表格、代码块等）。禁止在调用工具前后' +
    '说铺垫废话或道歉（如“好的”“稍等”“对不起，出现…”“让我看看”“Skipping…”之类），' +
    '直接调用工具或给一句最简短的回复即可。全程使用简体中文，不要中英混排。' +
    '【严禁输出工具名】永远不要把工具名或英文标识符（如 query_poem 等）' +
    '写进你的回答，它们不是给用户看的内容；需要执行操作时只调用工具本身，或在无法调用时' +
    '用一句简短中文说明，绝不把这些英文词吐出来。',
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
  auspicious: {
    found: (activity, days) => `帮你翻了黄历，最近的宜${activity}吉日：${days}。`,
    best: (days) => `帮你翻了黄历，最近最合适的日子：${days}。`,
    none: (activity) => `这一个月的黄历里都没找到宜${activity}的日子，换个事项或过阵子再问问我吧。`,
  },
  llmUnavailable: () => '这边一时没接上，你稍后再问我一次好吗？',
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
    chooseAgain: () => '没听清是第几件，请直接说编号，比如第三件。',
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
  news: {
    title: (keyword) => (keyword ? `${keyword}新闻播报` : '今日新闻播报'),
    playing: (title) => `正在为你播报：${title}。`,
    intro: (count, keyword) =>
      keyword
        ? `查到 ${count} 条与「${keyword}」相关的新闻：`
        : `为你播报今天的 ${count} 条新闻：`,
    none: (keyword) =>
      keyword ? `暂时没查到与「${keyword}」相关的新闻。` : '暂时没查到新闻。',
    unavailable: () => '现在查不了新闻，稍后再试。',
    candidates: (items) =>
      `找到几条新闻：${items.map((it, i) => `第${['一', '二', '三', '四', '五'][i] ?? i + 1}条，${it}`).join('；')}。`,
    chooseHint: () => '你想听第几条？',
    chooseAgain: () => '没听清选哪条，请说第几条。',
    noMore: () => '这几条新闻都播完啦，说「播放新闻」再给你找几条。',
  },
  baike: {
    prompt: () => '想查谁的百科？比如说「百科李存勖」。',
    playing: (title) => `正在为你播报：${title}。`,
  },
  sources: { smzdm: '什么值得买' },
  llmFallthrough: () => '抱歉，我刚才没反应过来，能再说一遍吗？',
  memory: {
    context: (items) =>
      items
        ? '\n\n以下是关于这位用户长期记住的信息（习惯 / 偏好 / 作息 / 日程等），回答时自然参考，不要逐条复述：\n' +
          items
        : '',
    remembered: (key, value) => `已记住：${key} —— ${value}。`,
    /** 偏好确认后口播：只念总结后的内容，不要 key/value 拼接（否则内容重复念两遍） */
    rememberedSimple: (value) => `已记住：${value}。`,
    forgot: (topic, n) => `已忘掉关于「${topic}」的 ${n} 条记忆。`,
    cleared: () => '已清空关于你的全部记忆。',
    nothingToForget: () => '没找到匹配的，没什么可忘的。',
    askRemember: () => '要我帮你记下来吗？',
    notRemembered: () => '好，那就不记了。',
  },
  memoryAuto: {
    extractSystem: () =>
      '你是语音助手「小熊」的记忆抽取引擎。你的唯一任务：阅读用户最近的口头表述，挑出值得长期记住的稳定事实。' +
      '只抽取关于这位用户的、稳定且长期有用的信息：习惯、偏好、作息规律、日程、重要的人/地点/事物、长期背景。' +
      '不要抽取一次性请求、临时需求、闲聊、或显而易见的内容。当新信息与已有记忆冲突时（例如起床时间改了），' +
      '复用同一个话题标签 key，让旧值被覆盖更新。每条 value 写成精炼摘要（尽量不超过 40 个汉字）。' +
      '你必须且只能调用 remember_many 工具一次，把抽取结果放进 entries（没有值得记的就传空数组）。不要输出任何文字回复。',
    extractTask: (history, existing) =>
      `已有记忆（若为空表示还没有）：\n${existing || '（无）'}\n\n` +
      `最近对话（用户原话）：\n${history}\n\n` +
      '请抽取值得长期记住的事实。',
    consolidateSystem: () =>
      '你是语音助手「小熊」的记忆合并引擎。下面是关于这位用户已存储的记忆，其中可能包含重复、零散或过时的内容。' +
      '请把重叠/重复的事实合并成单条精炼记忆，保留所有独特事实，不要丢掉重要信息。' +
      '每条 value 写成精炼摘要（尽量不超过 40 个汉字），优先用稳定的话题标签 key。' +
      '你必须且只能调用 remember_many 工具一次，返回合并后的完整记忆集合（不要遗漏任何独特事实）。不要输出任何文字回复。',
    consolidateTask: (existing) =>
      `已有记忆：\n${existing}\n\n请合并去重，返回精炼后的完整记忆集合。`,
  },
}

/**
 * 英文目录：音乐口播等其余文案先复用中文（按用户要求暂不动），
 * 只把喂给模型的 systemPrompt 国际化，让英文会话收到英文指令。
 */
const en: Messages = {
  ...zhCN,
  // skill 自带文案：英文覆盖（clock 来自 time_skill）
  clock: clockI18n.en,
  systemPrompt:
    'You are «XiongXiong», a voice assistant living inside the user\'s device. ' +
    'Reply concisely in English: no filler, no preamble, no repetition, but cover the content completely — ' +
    'when the user asks for a list (e.g. "top ten moments", "list N items"), enumerate every item; do not drop items just to be brief. ' +
    'No word limit; length follows the content. ' +
    '[Output & expression constraints] Output plain text only. No Markdown or formatting symbols ' +
    '(**bold**, # headings, list bullets, tables, code blocks, etc.). ' +
    'Do not add filler or apologies before or after calling a tool — ' +
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
  // 逐项显式覆盖：不再用 ...zhCN.music 展开，漏一项 TypeScript 就会报错，
  // 避免英文会话里忽然冒出中文口播。
  music: {
    playing: (title) => `Now playing: ${title}.`,
    switched: (title) => `Switched to: ${title}.`,
    paused: () => 'Paused.',
    resumed: () => 'Resumed.',
    stopped: () => 'Playback stopped.',
    notFound: (spoken) =>
      spoken
        ? "Couldn't find that content. Try a different name?"
        : "Couldn't find that song. Try a different title or artist?",
    notImplemented: (kind) =>
      `The music source "${sourceDisplayName(kind, 'en')}" is not yet available. Please switch to "${sourceDisplayName('baidu', 'en')}" in settings.`,
    candidates: (items) =>
      `Found some songs: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one? Say the number or the song title.',
    chooseAgain: () => "Didn't catch which song. Say the number or the title.",
    recommend: (items) =>
      `Here are some picks: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    recommendPrompt: () =>
      "What style are you in the mood for, or name an artist and I'll pick a few?",
    offerOtherType: () =>
      'No other content of the same type found. Shall I switch to something else, or would you name one?',
    switchedOther: () => 'No other content of the same type found; switching to something else.',
    looping: (count) => (count > 1 ? `Looping it ${count} times.` : 'Replaying once.'),
    loopNothing: () => 'Nothing is playing right now; play something first, then ask me to loop it.',
    volumeSet: (pct) => `Volume set to ${pct}%.`,
    volumeUp: (pct) => `Volume up — now ${pct}%.`,
    volumeDown: (pct) => `Volume down — now ${pct}%.`,
    volumeMax: () => 'Volume is already at maximum.',
    volumeMin: () => 'Volume is already at minimum.',
    subtitleOff: () => 'Subtitles off.',
    subtitleOn: () => 'Subtitles on.',
    subtitleNone: () => "No subtitles for this track. I've turned them on, and they'll show automatically when the next one has them.",
    subtitleNoActive: () => "There are no subtitles currently — they're already off.",
    musicNotPlaying: () => 'Nothing is playing right now; play something first.',
    playModeFloat: () => 'Switched to floating mode.',
    playModePlayer: () => 'Switched to player mode.',
    playModeToggled: () => 'Playback mode switched.',
  },
  memoryAuto: {
    extractSystem: () =>
      "You are the memory extraction engine for the voice assistant «XiongXiong». Your only job is to read the user's recent spoken utterances and pick out stable facts worth remembering long-term. " +
      'Extract ONLY durable, long-term-useful information about this user: habits, preferences, routine, schedule, important people/places/things, and long-term context. ' +
      'Do NOT extract one-off requests, transient needs, chit-chat, or anything obvious. When a new fact supersedes an existing one (e.g. a changed wake-up time), reuse the same topic key so the old value is overwritten. ' +
      'Keep each value a concise summary (ideally under 80 characters). You MUST call the remember_many tool exactly once with the extracted entries (empty array if nothing is worth saving). Do not output any text reply.',
    extractTask: (history, existing) =>
      `Existing memories (empty means none yet):\n${existing || '(none)'}\n\n` +
      `Recent conversation (user's own words):\n${history}\n\n` +
      'Extract the facts worth remembering long-term.',
    consolidateSystem: () =>
      "You are the memory consolidation engine for the voice assistant «XiongXiong». The memories below may contain duplicates, fragments, or outdated items. " +
      'Merge overlapping/duplicate facts into single concise entries, keep all unique facts, and do not drop anything important. ' +
      'Keep each value a concise summary (ideally under 80 characters), preferring stable topic keys. ' +
      'You MUST call the remember_many tool exactly once and return the consolidated full set (do not omit any unique fact). Do not output any text reply.',
    consolidateTask: (existing) =>
      `Existing memories:\n${existing}\n\nPlease merge and de-duplicate, returning the refined full set of memories.`,
  },
  // 与 music 一样逐项显式覆盖，不用 ...zhCN.deals 展开：漏一项 TypeScript 就会报错
  deals: {
    candidates: (items) =>
      `Found some items: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one? Just say the number.',
    chooseAgain: () => "Didn't catch which item. Just say the number, e.g. 'number 3'.",
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
  news: {
    title: (keyword) => (keyword ? `${keyword} news briefing` : 'News briefing'),
    playing: (title) => `Now playing the news: ${title}.`,
    intro: (count, keyword) =>
      keyword
        ? `Found ${count} news items about "${keyword}": `
        : `Here are today's ${count} news headlines: `,
    none: (keyword) =>
      keyword ? `No news found about "${keyword}".` : 'No news found right now.',
    unavailable: () => "Can't fetch news right now. Please try again later.",
    candidates: (items) =>
      `Found a few news videos: ${items.map((it, i) => `number ${i + 1}, ${it}`).join('; ')}.`,
    chooseHint: () => 'Which one would you like to play?',
    chooseAgain: () => "Didn't catch that. Which number?",
    noMore: () => "That's all the news for now. Say 'play news' to get more.",
  },
  baike: {
    prompt: () => 'Whose encyclopedia entry? For example, "wiki Einstein".',
    playing: (title) => `Now reading the encyclopedia entry for: ${title}.`,
  },
  sources: { smzdm: 'SMZDM' },
  auspicious: {
    // 日期/宜忌串为固定中文（历法表述不随语言英化，与日期直连同口径）
    found: (activity, days) => `Checked the almanac. Upcoming auspicious days for ${activity}: ${days}.`,
    best: (days) => `Checked the almanac. The most suitable upcoming days: ${days}.`,
    none: (activity) => `No almanac day for ${activity} in the coming month. Try another activity or ask again later.`,
  },
  llmUnavailable: () => "I couldn't connect this time. Could you ask me again in a moment?",
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

