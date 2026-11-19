import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from '../../src/service/voiceSessionService'
import { timeSkill } from '../../src/service/skills/time_skill'
import { preferenceSkill } from '../../src/service/skills/preference_skill'
import { createWeatherSkill } from '../../src/service/skills/weather_skill'
import { auspiciousSkill } from '../../src/service/skills/auspicious_skill'
import { ChannelSplitter } from '../../src/service/channelSplitter'
import type { VoiceSessionDeps } from '../../src/service/voiceSessionService'
import type { AgentService } from '../../src/service/agentService'
import type { AsrProvider } from '../../src/asr'
import type { TtsProvider } from '../../src/tts'
import type { DataService } from '../../src/service/dataService'
import type { ResolvedCapabilities } from '../../src/voiceConfig'
import type { ServerEvent } from '../../src/protocol'
import type { HealthReport } from '../../src/service/health'
import type { MusicSource } from '../../src/service/skills/music_skill/music/types'
import type { PoemEntry } from '../../src/service/edu'
import type { DealsSnapshot } from '../../src/service/tools/dealsTool'
import type { Deal, DealDetail } from '../../src/service/deals'
import type { BaikeEntry } from '../../src/service/baike'

/** 100ms 的方波人声帧（16k/16bit/mono），能量远高于自适应门限。 */
function loudFrame(samples = 1600): Uint8Array {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 2 === 0 ? 12000 : -12000
  return new Uint8Array(pcm.buffer)
}

function silentFrame(samples = 1600): Uint8Array {
  return new Uint8Array(samples * 2)
}

/**
 * 正常说话音量帧（RMS≈0.03，约 loudFrame 12000 的 1/12）：模拟用户正常音量而非大喊，
 * 用来验证播报期这种音量也能进 ASR 并下发草稿，让说话当下有识别文字。
 */
function normalFrame(samples = 1600): Uint8Array {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 2 === 0 ? 1000 : -1000
  return new Uint8Array(pcm.buffer)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把文本切成定长小块，模拟流式下发。 */
function chunkText(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

interface Harness {
  service: VoiceSessionService
  events: ServerEvent[]
  agentCalls: () => number
  /** 智能体工厂被调用的次数：re-arm 不重建 agent 时应保持不变 */
  agentFactoryCalls: () => number
  /** 让当前这一轮的 reply 立刻 resolve */
  finishReply: () => void
  /** 模拟客户端播完回执 */
  playbackDone: () => void
  /** 被真正喂进 ASR 的帧数，用来验证回声门控 */
  asrFrames: () => number
  /** 记忆直连命令落地时，记录被 forget 的 topic（undefined 表示清空全部） */
  forgetCalls: () => Array<{ deviceId: string | null; topic?: string }>
  /** 最近一次 agentFactory 收到的 memoryContext（验证系统提示注入了记忆） */
  lastMemoryContext: () => string | undefined
  /** 自动记忆抽取被调用的次数 */
  extractCalls: () => number
  /** 最近一次抽取喂入的「最近用户原话」上下文（数组的数组，每次抽取一条） */
  lastExtractHistory: () => Array<string[]>
  /** 注入抽取结果：下几次 extractMemories 返回这些条目（验证落库） */
  setExtractResult: (items: Array<{ key: string; value: string }>) => void
  /** 自动记忆被写入存储的条目（key/value） */
  savedMemories: () => Array<{ key: string; value: string }>
  /** 合并（摘要）被触发的次数（验证阈值/频率配置生效） */
  consolidateCalls: () => number
  /** 模拟工具层通过 emit 通道下发事件（如开源项目卡片） */
  emitMedia: (m: ServerEvent) => void
}

function createHarness(
  opts: {
    ttsFrames?: Uint8Array[]
    delayDelta?: boolean
    finalizeText?: string
    /** 多轮定稿文本队列：每次 finalize 依次取一个，用尽后重复最后一个 */
    finalizeTexts?: string[]
    /** asr.push 返回的实时草稿：驱动 handleBinary 的 asr.partial 下发条件验证 */
    partialText?: string
    musicSourceFactory?: () => MusicSource
    candidateFetcher?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    /** 句末静音定稿阈值（毫秒）；默认 10ms，贴近真实长停顿测试时调大 */
    asrEndpointMs?: number
    /** ASR 纠错桩；默认 no-op（避免 pinyin 开销打乱时序），纠错本身由 asrCorrector.test.ts 覆盖 */
    asrCorrect?: (text: string) => string
    /** LLM 超时（ms）：注入小值验证超时兜底 + 队列继续消费（回归排队卡死） */
    llmTimeoutMs?: number
    /** TTS 帧间看门狗（ms）：注入小值验证上游挂起时链不死 */
    ttsFrameGapMs?: number
    /** TTS 合成挂起：吐一帧后永不结束（验证帧间看门狗） */
    ttsStall?: boolean
    /** 预置记忆：全新会话 start 时由 getMemories 返回，用于验证系统提示注入 */
    memories?: Array<{ key: string; value: string; updatedAt: number }>
    /** 设备标识；传 null 可验证「无 deviceId 不注入记忆」。默认 test-device */
    deviceId?: string | null
    /** 懒加载定位超时（毫秒）；测试压短，默认 50ms */
    locationRequestTimeoutMs?: number
    /** 自动记忆合并（摘要）阈值：覆盖缺省，验证配置可注入 */
    consolidateThreshold?: number
    /** 自动记忆合并（摘要）频率：覆盖缺省，验证配置可注入 */
    consolidateEvery?: number
    /** 注入能力探测桩：返回各能力 reachable 与否；缺省「全部就绪」，不下发 client.cue */
    capabilityProbe?: () => Promise<HealthReport | null>
    /** 注入商品/好价查询桩（口播文本 + 结构化 Deal[]），避免直连用例真的联网抓页面 */
    dealsQuery?: () => Promise<DealsSnapshot>
    /** 注入新闻视频候选（标题/BVID），避免新闻用例真的联网搜 B 站 */
    newsHits?: Array<{ bvid: string; title: string; cover?: string }>
    /** 记录 search 收到的关键词（话题词断言） */
    newsKeywordSpy?: (keyword: string | null) => void
    /** 注入抽音轨结果（m4s 直链）；缺省返回 null（抽不到→回退实时口播兜底） */
    newsAudioUrl?: string | null
    /** 注入百科查询桩（词条结构 + 口播文本），避免百科用例真的联网抓百度 */
    baikeQuery?: (query: string) => Promise<{ entry: BaikeEntry | null; text: string }>
    /** 记录百科查询收到的关键词 */
    baikeQuerySpy?: (query: string) => void
    /** 注入百科音频直链桩，避免百科用例真的调百度 getaudio。缺省给固定假 URL。 */
    baikeAudioUrl?: (text: string) => Promise<string>
    /** 注入诗词查询桩，避免诗词用例真的联网抓百度。缺省返回 null（查不到）。 */
    poemQuery?: (title: string) => Promise<PoemEntry | null>
    /** 注入详情页补充信息桩；缺省返回 null（不联网），需要验证合并时再注入 */
    dealsDetail?: (deal: Deal) => Promise<DealDetail | null>
    /** 智能体口播文本（经 ChannelSplitter 下发）；默认「好的，我来说一句。」。可注入泄漏标记验证兜底 */
    replyText?: string,
    /** 覆盖 resolveVoice：默认忽略 voice 返回空配置；需要验证「切来源重建 agent」时注入，
     *  按 voice.provider 返回不同的 llm 配置指纹，使重武装能识别来源变化。 */
    resolveVoice?: (voice?: unknown) => ResolvedCapabilities,
    /** 注入启用的 skill 模块（默认空，隔离各用例）；验证偏好追问流程时注入 preferenceSkill。 */
    skillModules?: VoiceSessionDeps['skillModules'],
  } = {}
): Harness {
  const ttsFrames = opts.ttsFrames ?? []
  const events: ServerEvent[] = []
  let calls = 0
  let frames = 0
  let factoryCalls = 0
  let textIdx = 0
  let finish: (() => void) | null = null
  let emitFn: ((m: ServerEvent) => void) | undefined
  const replyText = opts.replyText ?? '好的，我来说一句。'
  let extractCalls = 0
  let lastExtractHistory: Array<string[]> = []
  let extractResult: Array<{ key: string; value: string }> = []
  let consolidateCalls = 0
  const agent: AgentService = {
    reply(_text, onDelta, onThinking) {
      calls += 1
      if (opts.delayDelta) {
        // 思考阶段不下发 TTS：processing 已为 true、playbackPending 仍为 false，
        // 用来验证「未播放时用户插话进队列」这条生存下来的排队路径。
        let resolveReply!: (value: string) => void
        const pending = new Promise<string>((resolve) => {
          resolveReply = resolve
        })
        finish = () => {
          onDelta(replyText)
          resolveReply(replyText)
        }
        return pending
      }
      // 走与真实 agentService 相同的 ChannelSplitter，保证泄漏标记被剥离后再下发
      const sp = new ChannelSplitter(
        (s) => onDelta(s),
        (s) => onThinking?.(s)
      )
      for (const piece of chunkText(replyText, 5)) sp.push(piece)
      sp.end()
      return new Promise<string>((resolve) => {
        finish = () => resolve(replyText)
      })
    },
    // 自动记忆抽取桩：记录调用与最近上下文，并由用例注入返回条目以验证落库。
    async extractMemories(history) {
      extractCalls += 1
      lastExtractHistory.push(history.slice())
      return extractResult
    },
    async consolidateMemories() {
      consolidateCalls += 1
      return []
    },
    mcpClients: [],
    async closeMcp() {},
  }
  const asr: AsrProvider = {
    async push() {
      frames += 1
      // partialText 注入：验证 handleBinary 的 asr.partial 下发条件（插话放行 / 回声抑制）。
      // 只在「播报窗口」（tts.end 已下发、playback_done 未回）生效，避免空闲监听期的
      // speakUtterance 自身上行把草稿提前刷出来干扰断言。
      if (!opts.partialText) return null
      const playbackWindow = events.some((e) => e.type === 'tts.end')
      if (!playbackWindow) return null
      return opts.partialText
    },
    async finalize() {
      if (opts.finalizeTexts?.length) {
        const t = opts.finalizeTexts[Math.min(textIdx, opts.finalizeTexts.length - 1)]
        textIdx += 1
        return t
      }
      // 默认用中性闲聊句：不命中天气/时间/商品/音乐等任何直连命令，确保验证的是 agent 路径
      return opts.finalizeText ?? '你好，随便聊聊'
    },
    reset() {},
  }
  const tts: TtsProvider = {
    async *synthesize() {
      for (const frame of ttsFrames) yield frame
      // 模拟 TTS 上游挂起：吐完注入帧后永不结束，验证帧间看门狗断开本句、对话链不死
      if (opts.ttsStall) await new Promise<void>(() => undefined)
    },
  }

  let service!: VoiceSessionService
  const forgetCalls: Array<{ deviceId: string | null; topic?: string }> = []
  const savedMemories: Array<{ key: string; value: string }> = []
  let lastMemoryContext: string | undefined
  const data = {
    createSession: async () => 1,
    endSession: async () => {},
    insertCommandLog: () => {},
    saveMemory: async (_deviceId: string | null, key: string, value: string) => {
      savedMemories.push({ key, value })
    },
    getMemories: async () => opts.memories ?? [],
    forgetMemory: async (deviceId: string | null, topic?: string) => {
      forgetCalls.push({ deviceId, topic })
      return 1
    },
  } as unknown as DataService
  const deps: VoiceSessionDeps = {
    agentFactory: (_llm, _lang, _tz, _loc, _music, emit, _store, memoryContext) => {
      factoryCalls += 1
      lastMemoryContext = memoryContext
      emitFn = emit
      return agent
    },
    createAsr: () => asr,
    createTts: () => tts,
    resolveVoice: opts.resolveVoice ?? (() => ({}) as unknown as ResolvedCapabilities),
    data,
    send: (event) => events.push(event),
    sendAudio: () => {},
    // 纠错器默认 no-op：避免 pinyin 计算的同步开销打乱本文件精确的 sleep 时序；
    // 纠错本身由 asrCorrector.test.ts 单独覆盖。
    asrCorrect: opts.asrCorrect ?? ((t: string) => t),
    // 媒体短链缓存默认 no-op（返回 null→回退原始 url），避免测试真去下载第三方音频
    mediaCache: async () => null,
    asrEndpointMs: opts.asrEndpointMs ?? 10,
    llmTimeoutMs: opts.llmTimeoutMs,
    ttsFrameGapMs: opts.ttsFrameGapMs,
    musicSourceFactory: opts.musicSourceFactory,
    candidateFetcher: opts.candidateFetcher,
    dealsQuery: opts.dealsQuery,
    // 百科查询桩：透传注入的 query（含关键词记录），缺省走默认工具
    baikeQuery: opts.baikeQuery
      ? async (query: string) => {
          opts.baikeQuerySpy?.(query)
          return opts.baikeQuery!(query)
        }
      : undefined,
    // 百科音频直链桩：缺省给固定假 URL，避免测试真的调百度 getaudio 联网。
    baikeAudioUrl: opts.baikeAudioUrl ?? (async () => 'https://tts.baidu.com/test.mp3'),
    // 诗词查询桩：缺省返回 null（查不到），避免诗词用例真的联网抓百度。
    poemQuery: opts.poemQuery ?? (async () => null),
    // 新闻视频源桩：search 返回注入候选，resolveBvid 返回注入音轨（缺省 null→走兜底口播）
    newsVideoSource: {
      name: 'test-news-video',
      searchKeyword: (keyword: string | null) => (keyword ? `${keyword} 新闻` : '今日新闻'),
      search: async (keyword: string | null) => {
        opts.newsKeywordSpy?.(keyword)
        return opts.newsHits ?? []
      },
      resolveBvid: async (c: { bvid: string; title: string; cover?: string }) =>
        opts.newsAudioUrl ? { url: opts.newsAudioUrl, title: c.title, bvid: c.bvid, ...(c.cover ? { cover: c.cover } : {}) } : null,
    },
    // 默认不抓详情页：单测不联网；需要验证补充信息合并时由用例注入
    dealsDetail: opts.dealsDetail ?? (async () => null),
    locationRequestTimeoutMs: opts.locationRequestTimeoutMs ?? 50,
    consolidateThreshold: opts.consolidateThreshold,
    consolidateEvery: opts.consolidateEvery,
    deviceId: opts.deviceId === undefined ? 'test-device' : opts.deviceId,
    // 默认「全部就绪」，避免每个用例都下发 client.cue；需要验证不可用时由调用方注入 capabilityProbe
    capabilityProbe: opts.capabilityProbe,
    // 默认注入已实现的 skill（贴近生产装配）：time 走 onDirectCommand 直连、preference 走 onFinalize。
    // 显式传 skillModules 的用例（如 spy 测试）可覆盖。
    skillModules: opts.skillModules ?? [
      auspiciousSkill,
      timeSkill,
      createWeatherSkill({
        name: 'test-weather',
        fetch: async () => ({ current: { temperature_2m: 25, weather_code: 0 } }),
        fetchCity: async (city: string) => ({ current: { temperature_2m: 25, weather_code: 0 }, city }),
      } as never),
      preferenceSkill,
    ],
  }
  service = new VoiceSessionService(deps)
  return {
    service,
    events,
    agentCalls: () => calls,
    agentFactoryCalls: () => factoryCalls,
    finishReply: () => finish?.(),
    playbackDone: () => service.handleText(JSON.stringify({ type: 'session.playback_done' })),
    asrFrames: () => frames,
    forgetCalls: () => forgetCalls,
    lastMemoryContext: () => lastMemoryContext,
    extractCalls: () => extractCalls,
    lastExtractHistory: () => lastExtractHistory,
    setExtractResult: (items) => {
      extractResult = items
    },
    savedMemories: () => savedMemories,
    consolidateCalls: () => consolidateCalls,
    emitMedia: (m) => emitFn?.(m),
  }
}

async function startDialog(service: VoiceSessionService, lang = 'zh-CN'): Promise<void> {
  service.handleText(JSON.stringify({ type: 'session.start', sessionId: 's1', lang }))
  await sleep(5)
}

/** 以指定自动记忆开关开启一个对话会话（验证抽取是否被触发）。 */
async function startDialogWithMemory(
  service: VoiceSessionService,
  auto: boolean,
  lang = 'zh-CN'
): Promise<void> {
  service.handleText(
    JSON.stringify({ type: 'session.start', sessionId: 's1', lang, memory: { auto } })
  )
  await sleep(5)
}

/** 说一句完整的话并等网关定稿（VAD 尾音 300ms 后再确认下一句）。 */
async function speakUtterance(h: Harness): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    h.service.handleBinary(silentFrame())
    await sleep(80)
  }
  // strict 模式要连续 4 帧超门限才确认开口
  for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
  await sleep(40)
}

describe('语音会话：句末判定、排队与去噪', () => {
  it('静音不触发，只有确认说完才请求大模型', async () => {
    const h = createHarness()
    await startDialog(h.service)

    for (let i = 0; i < 5; i += 1) h.service.handleBinary(silentFrame())
    await sleep(30)
    expect(h.agentCalls()).toBe(0)

    h.service.handleBinary(loudFrame())
    h.service.handleBinary(loudFrame())
    expect(h.agentCalls()).toBe(0)

    await sleep(30)
    expect(h.events.some((e) => e.type === 'asr.final')).toBe(true)
    expect(h.agentCalls()).toBe(1)
    h.finishReply()
  })

  it('播报期短促插话（2 帧 ≈512ms）也能进队列——旧的四帧要求会让它完全不识别', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)
    // 必须等 TTS 真正开播（playbackPending=true）再插话，否则测的是普通门槛
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === 'tts.start'); i += 1) await sleep(10)
    expect(h.events.some((e) => e.type === 'tts.start')).toBe(true)

    // 让 VAD 退出上一句：播报中天然有静音间隙（>hangover 800ms），不退出就测不到「开口判定」
    await sleep(900)
    h.service.handleBinary(silentFrame())

    // 播报中：只持续 2 帧（≈512ms）的短促插话。旧实现要求连续 4 帧（≈1 秒）才确认开口，
    // 「停一下」这种半秒短句永远确认不了，用户体感「播报时根本不识别」。
    h.service.handleBinary(loudFrame())
    h.service.handleBinary(loudFrame())
    await sleep(60)

    const queued = h.events.filter((e) => e.type === 'asr.queued')
    expect(queued).toHaveLength(1)
    // 仍不打断当前句、不发起新轮次
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
    expect(h.agentCalls()).toBe(1)
    h.finishReply()
    await sleep(10)
  })

  it('播报期间插话排队：当前句播完后按序处理，不中途打断', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)

    // 播报中（playbackPending=true）连续三句插话：都进队列（asr.queued），
    // 不打断当前句、不发起新轮次、不回传 asr.final 顶掉「我说」卡片
    await speakUtterance(h)
    await speakUtterance(h)
    await speakUtterance(h)
    const queued = h.events.filter((e) => e.type === 'asr.queued')
    expect(queued).toHaveLength(3)
    expect(queued[0]).toMatchObject({ position: 1, size: 3 })
    expect(queued[2]).toMatchObject({ position: 3, size: 3 })
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
    expect(h.agentCalls()).toBe(1)

    // 当前句收尾并回执播完：队首被消费成新一轮，queueRemaining 为剩余 2 句（权威值）
    h.finishReply()
    h.playbackDone()
    await sleep(40)
    expect(h.agentCalls()).toBe(2)
    const finals = h.events.filter((e) => e.type === 'asr.final')
    expect(finals[finals.length - 1]).toMatchObject({ queueRemaining: 2 })
    h.finishReply()
    await sleep(10)
  })

  it('思考阶段（未播放）用户插话：正常进队列，播完后依次处理', async () => {
    // delayDelta：智能体先思考、不下发 TTS，制造「processing=true 且 playbackPending=false」的窗口
    const h = createHarness({ delayDelta: true })
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)

    // 思考阶段插话 → 排队（此时还没开始播放，所以允许识别）
    await speakUtterance(h)
    const queued = h.events.filter((e) => e.type === 'asr.queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ position: 1, size: 3 })

    // 思考结束并播报
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)
    expect(h.agentCalls()).toBe(1)

    // 播完回执后，队列里的那句被消费成新一轮
    h.playbackDone()
    await sleep(30)
    expect(h.agentCalls()).toBe(2)
    const finals = h.events.filter((e) => e.type === 'asr.final')
    expect(finals[1]).toMatchObject({ queueRemaining: 0 })
  })

  it('播报/思考中 session.skip_current：只跳过当前句，队列未被清空且下一句继续处理', async () => {
    // delayDelta：先制造「思考阶段插话排队」——第一句进入 agent 但未下发 TTS，
    // 此时第二句插话进队列。随后 finishReply 让第一句开始播报，播报中收到 skip_current。
    const h = createHarness({ delayDelta: true })
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)

    // 思考阶段插话排队
    await speakUtterance(h)
    const queued = h.events.filter((e) => e.type === 'asr.queued')
    expect(queued).toHaveLength(1)

    // 第一句开始播报（playbackPending=true，等 playback_done）
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)

    // 播报中重新喊唤醒词 → 客户端发 skip_current：停当前句、保留队列
    h.service.handleText(JSON.stringify({ type: 'session.skip_current' }))
    await sleep(60)

    // 当前句被 tts.stop 掐掉（证明跳过生效，不是整轮 cancel 才停）
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(true)
    // 队列未被清空：排队句被 shift 出来，作为新的 agent 轮次继续处理
    expect(h.agentCalls()).toBe(2)
    // 回放句通过 asr.final 下发，且 queueRemaining 归零（队列确实被消费而非丢弃）
    const finals = h.events.filter((e) => e.type === 'asr.final')
    expect(finals[finals.length - 1]).toMatchObject({ queueRemaining: 0 })
    // 没有走整轮重来：不应有队列拒收噪声
    expect(h.events.some((e) => e.type === 'asr.rejected')).toBe(false)

    // 收尾：让回放句的 agent 也 resolve，避免悬挂
    h.finishReply()
    await sleep(10)
  })

  it('session.skip_current 在无轮次进行时是空操作', async () => {
    const h = createHarness()
    await startDialog(h.service)
    // 空闲（未思考、未播报）时收到 skip_current：不产生任何 tts.stop，也不发起轮次
    h.service.handleText(JSON.stringify({ type: 'session.skip_current' }))
    await sleep(20)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
    expect(h.agentCalls()).toBe(0)
  })

  it('播报中喊「小熊小熊」：asr.queued 透传唤醒词，skip_current+dropText 删掉它、队列其它句继续', async () => {
    // 三次定稿依次为：首句指令、思考期插话、播报期唤醒词。
    const h = createHarness({
      delayDelta: true,
      finalizeTexts: ['你好，聊聊第一个话题', '你好，聊聊第二个话题', '小熊小熊'],
    })
    await startDialog(h.service)
    await speakUtterance(h) // 首句 → agent(1)，delayDelta 制造「思考中」窗口
    expect(h.agentCalls()).toBe(1)

    // 思考阶段先排一句普通问句（不命中任何直连命令，回放时进 runAgent）
    await speakUtterance(h)
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(1)

    // 首句开始播报（playbackPending=true，等 playback_done）
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    // 播报中（未回执播完）再喊唤醒词：这句经 asr.queued 把原文透传给客户端做匹配
    await speakUtterance(h)
    const wakeQueued = h.events.filter((e) => e.type === 'asr.queued' && e.text === '小熊小熊')
    expect(wakeQueued).toHaveLength(1)

    // 客户端命中唤醒词 → 发 skip_current 带 dropText：网关删掉这句唤醒词、只跳当前句
    h.service.handleText(JSON.stringify({ type: 'session.skip_current', dropText: '小熊小熊' }))
    await sleep(60)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(true)
    // 队列未被清空：普通问句被 shift 出来继续处理；唤醒词没有被当成一句话交给 LLM
    expect(h.agentCalls()).toBe(2)
    const finals = h.events.filter((e) => e.type === 'asr.final')
    expect(finals[finals.length - 1]).toMatchObject({ text: '你好，聊聊第二个话题', queueRemaining: 0 })
    expect(finals.some((e) => e.type === 'asr.final' && e.text === '小熊小熊')).toBe(false)
    h.finishReply()
    await sleep(10)
  })

  it('队列已满：asr.rejected 仍带回识别原文，供客户端识别唤醒词打断', async () => {
    const h = createHarness({
      delayDelta: true,
      finalizeTexts: ['你好，随便聊聊', '插话1', '插话2', '插话3', '小熊小熊'],
    })
    await startDialog(h.service)
    await speakUtterance(h) // 首句 → agent(1)，思考中
    // 思考阶段连插 4 句：前 3 句入队，第 4 句（唤醒词）队列满 → asr.rejected（仍带 text）
    await speakUtterance(h)
    await speakUtterance(h)
    await speakUtterance(h)
    await speakUtterance(h)
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(3)
    const rejected = h.events.filter((e) => e.type === 'asr.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: 'queue-full', text: '小熊小熊' })
    h.finishReply()
    await sleep(10)
  })

  it('tts.end 之后、playback_done 之前：回声（助手原话）被丢弃，不回传也不发起轮次', async () => {
    // 下发一帧高能量 TTS 音频，让门控拿到参考值；finalize 固定返回助手刚念过的原话，模拟回声
    const h = createHarness({ ttsFrames: [loudFrame()], finalizeText: '好的，我来说一句。' })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    // 此刻音频已下发完（speaking=false），但客户端还没回执播完。
    // 回声（与助手原话雷同）必须被丢弃：既不回传 asr.final，也不排队 / 拒收，更不发起新轮次。
    const before = h.events.filter((e) => e.type === 'asr.final').length
    for (let i = 0; i < 8; i += 1) h.service.handleBinary(loudFrame())
    await sleep(40)
    expect(h.events.filter((e) => e.type === 'asr.final')).toHaveLength(before)
    expect(h.events.some((e) => e.type === 'asr.queued' || e.type === 'asr.rejected')).toBe(false)
    expect(h.agentCalls()).toBe(1)
  })

  it('tts.end 之后、playback_done 之前：其它声音进队列（asr.queued）但不发起新轮次', async () => {
    // 播报期间非回声的插话也排队：网关把原文随 asr.queued 透传给客户端做「小熊小熊」比对，
    // 但绝不发起新轮次、不回传 asr.final 顶掉「我说」卡片、不打断当前播报。
    const h = createHarness({ ttsFrames: [loudFrame()] })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    const before = h.events.filter((e) => e.type === 'asr.final').length
    for (let i = 0; i < 8; i += 1) h.service.handleBinary(loudFrame())
    await sleep(40)
    expect(h.events.filter((e) => e.type === 'asr.final')).toHaveLength(before)
    expect(h.agentCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'asr.queued' || e.type === 'asr.rejected')).toBe(true)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
  })

  it('打断后串行链里残留的定稿不会再发 asr.final 或排队', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)

    // 手动打断，然后模拟一个还挂在链里的 endpoint 定稿
    h.service.handleText(JSON.stringify({ type: 'session.cancel' }))
    await sleep(20)
    const afterCancel = h.events.length
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(40)
    const added = h.events.slice(afterCancel).filter((e) => e.type === 'asr.final' || e.type === 'asr.queued')
    expect(added).toHaveLength(0)
  })
})

describe('音乐控制直连命令：我说卡片与口播文案', () => {
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })

  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('播放命中：下发 asr.final（我说卡片显示这句）+ media.play，不进 LLM', async () => {
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const finals = h.events.filter((e) => e.type === 'asr.final') as Array<{ type: 'asr.final'; text: string }>
    expect(finals.some((e) => e.text === '播放周杰伦的稻香')).toBe(true)
    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
    // 直连绕开 LLM：不应调用 agent
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('正在为你播放')
  })

  /** 两份结构化商品（第二份缺 image，验证换源/字段缺失容忍） */
  const sampleDeals: Deal[] = [
    { title: '示例商品A', price: '9.9元', mall: '京东', tags: ['历史低价'], link: 'https://x/a', image: 'https://img/a.jpg' },
    { title: '示例商品B', price: '20元', mall: '天猫', tags: [], link: 'https://x/b' },
  ]

  it('「有什么折扣」直连查商品/好价：绕开 LLM + 口播编号 + 下发详情列表', async () => {
    let queried = 0
    const h = createHarness({
      finalizeText: '有什么折扣',
      dealsQuery: async () => {
        queried += 1
        return { text: '查到 2 件最新好价', deals: sampleDeals }
      },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(queried).toBe(1)
    expect(h.agentCalls()).toBe(0)
    // 口播的是编号列表话术（价格等详情只在卡片展示，不逐条朗读）
    expect(texts(h)).toContain('第一件，示例商品A')
    const detail = h.events.find((e) => e.type === 'media.detail')
    expect(detail).toBeDefined()
    expect(detail && detail.type === 'media.detail' && detail.items).toHaveLength(2)
    expect(detail && detail.type === 'media.detail' && detail.selectedIndex).toBeUndefined()
  })

  it('没查到好价也照常播报兜底文案，且不进 LLM', async () => {
    const h = createHarness({
      // 「查询商品」按用户口径不再直连；这里用好价信号句验证直连兜底
      finalizeText: '有什么优惠',
      dealsQuery: async () => ({ text: '暂时没有查到好价。', deals: [] }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('暂时没有查到好价')
  })

  it('泛词「东西」不直连，交 LLM（不劫持正常对话、不查商品）', async () => {
    let queried = 0
    const h = createHarness({
      // 长句：不会被「裸歌名」音乐直连误判，能真正走到 LLM
      finalizeText: '把这个东西拿过来给我看看',
      dealsQuery: async () => {
        queried += 1
        return { text: '不该被调用', deals: [] }
      },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 核心断言：泛词不得触发商品查询（其余直连链怎么处理是既有行为，不在此断言）
    expect(queried).toBe(0)
    expect(texts(h)).not.toContain('不该被调用')
  })

  it('说「第二个」选中第 2 件：下发 media.detail(selectedIndex=2)、不进 LLM', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '第二个'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    // 先下发编号列表（selectedIndex 缺省）
    expect(h.events.some((e) => e.type === 'media.detail' && e.selectedIndex === undefined)).toBe(true)

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const selected = h.events.filter(
      (e) => e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect((selected[0] as { selectedIndex: number }).selectedIndex).toBe(2)
    // 只口播一句编号确认，不复述商品价格等详情；全程绕开 LLM
    expect(texts(h)).toContain('第 2 件商品详情')
    expect(h.agentCalls()).toBe(0)
  })

  it('选中后补抓详情页：优惠说明/品牌并入该条，仍走统一 fields[]（客户端无感知来源）', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '第二个'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
      dealsDetail: async () => ({ desc: '领券后实付 18 元', brand: '示例品牌', time: 1794386285 }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(50)

    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    const item = selected[0].items[1]
    // 详情页信息只表现为多出的 fields 行，结构与其他源完全一致
    expect(item.fields?.map((f) => f.label)).toEqual([
      '现价',
      '商城',
      '品牌',
      '优惠详情',
      '发布时间',
    ])
    expect(item.fields?.find((f) => f.label === '品牌')?.value).toBe('示例品牌')
    expect(item.fields?.find((f) => f.label === '优惠详情')?.value).toBe('领券后实付 18 元')
    // 没被选中的那件不带详情页信息
    expect(selected[0].items[0].fields?.some((f) => f.label === '优惠详情')).toBe(false)
  })

  it('详情页抓取失败不影响选号：照常下发 selectedIndex，用列表数据展示', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '第一个'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
      dealsDetail: async () => {
        throw new Error('detail down')
      },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(50)

    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect(selected[0].selectedIndex).toBe(1)
    expect(selected[0].items[0].fields?.map((f) => f.label)).toEqual([
      '现价',
      '商城',
      '优惠',
    ])
  })

  it('推荐商品依据长期记忆：偏好咖啡时咖啡商品排到第 1 件', async () => {
    const deals: Deal[] = [
      { title: '无线蓝牙耳机', price: '99元', mall: '京东', tags: [], link: 'https://x/a' },
      { title: '云南咖啡豆 500g', price: '39元', mall: '天猫', tags: [], link: 'https://x/b' },
      { title: '猫粮 10kg', price: '199元', mall: '京东', tags: [], link: 'https://x/c' },
    ]
    const h = createHarness({
      finalizeText: '推荐几件打折的商品',
      memories: [{ key: '偏好', value: '喜欢喝咖啡', updatedAt: 0 }],
      dealsQuery: async () => ({ text: '查到 3 件最新好价', deals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const detail = h.events.find(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> => e.type === 'media.detail',
    )
    expect(detail?.items[0].title).toBe('云南咖啡豆 500g')
    // 口播顺序与卡片顺序一致，用户说「第一个」拿到的是同一件
    expect(texts(h)).toContain('第一件，云南咖啡豆 500g')
  })

  it('没有记忆时不个性化：顺序与数据源原顺序一致', async () => {
    const deals: Deal[] = [
      { title: '无线蓝牙耳机', price: '99元', mall: '京东', tags: [], link: 'https://x/a' },
      { title: '云南咖啡豆 500g', price: '39元', mall: '天猫', tags: [], link: 'https://x/b' },
    ]
    const h = createHarness({
      finalizeText: '推荐几件打折的商品',
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const detail = h.events.find(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> => e.type === 'media.detail',
    )
    expect(detail?.items.map((i) => i.title)).toEqual(['无线蓝牙耳机', '云南咖啡豆 500g'])
  })

  it('说「第三件」（商品量词）也能选中第 3 件，且不会落到点歌/大模型', async () => {
    const three: Deal[] = [
      ...sampleDeals,
      { title: '第三件商品', price: '30元', mall: '京东', tags: [], link: 'https://x/c' },
    ]
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '第三件'],
      dealsQuery: async () => ({ text: '查到 3 件最新好价', deals: three }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect(selected[0].selectedIndex).toBe(3)
    expect(texts(h)).toContain('第 3 件商品详情')
    expect(h.agentCalls()).toBe(0)
  })

  it('列完商品后一句没说清（不是编号），再说「第二件」仍能选中：列表不被清掉', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '那个商品怎么样', '第二件'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    expect(h.events.some((e) => e.type === 'media.detail' && e.selectedIndex === undefined)).toBe(true)

    // 中间这句含糊话正常处理，但卡片还在屏幕上，选号状态要留住
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect(selected[0].selectedIndex).toBe(2)
    expect(texts(h)).toContain('第 2 件商品详情')
  })

  it('说「第几个」没对上：就地重问、不进 LLM，后面再说编号还能选中', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '第几个', '第二件'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    h.playbackDone()
    await sleep(20)
    const callsBefore = h.agentCalls()
    await speakUtterance(h)
    await sleep(30)
    // 这句被当成「想选号但没说清」消费掉，绝不放行到大模型（否则会被答成音乐/推荐歌曲）
    expect(h.agentCalls()).toBe(callsBefore)
    expect(texts(h)).toContain('没听清是第几件')

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)
    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect(selected[0].selectedIndex).toBe(2)
  })

  it('切语音来源（rearm 重发 session.start）后商品编号仍可选：pendingDeals 不被清空', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '2'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: sampleDeals }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 模拟设置页切 provider → rearm 重发 session.start（同一会话实例，走 re-arm 早返回）
    h.service.handleText(
      JSON.stringify({
        type: 'session.start',
        sessionId: 's1',
        lang: 'zh-CN',
        voice: { provider: 'dashscope', url: 'https://x', apiKey: 'k' },
      }),
    )
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const selected = h.events.filter(
      (e) => e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect((selected[0] as { selectedIndex: number }).selectedIndex).toBe(2)
    expect(h.agentCalls()).toBe(0)
  })

  it('自动字幕开启：播放后同源自动拉取并下发 media.subtitle，字幕不进 LLM', async () => {
    const subtitleLines = [
      { time: 1, text: '第一句' },
      { time: 5, text: '第二句' },
    ]
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        getSubtitle: async () => subtitleLines,
      }),
    })
    // 显式下发带 autoSubtitle:true 的 session.start
    h.service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', playback: { source: 'baidu', autoSubtitle: true } })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
    const sub = h.events.find((e) => e.type === 'media.subtitle') as
      | { type: 'media.subtitle'; title: string; artist?: string; lines: Array<{ time: number; text: string }> }
      | undefined
    expect(sub).toBeDefined()
    expect(sub?.title).toBe('稻香')
    expect(sub?.artist).toBe('周杰伦')
    expect(sub?.lines).toEqual(subtitleLines)
    // 字幕只在客户端展示，绝不进 TTS / LLM
    expect(texts(h)).not.toContain('第一句')
  })

  it('自动字幕关闭：播放后不下发 media.subtitle', async () => {
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        getSubtitle: async () => [{ time: 1, text: '第一句' }],
      }),
    })
    h.service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', playback: { source: 'baidu', autoSubtitle: false } })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
    expect(h.events.some((e) => e.type === 'media.subtitle')).toBe(false)
  })

  it('循环播放（复用当前曲）也重新下发同源字幕，不会「循环后字幕没出来」', async () => {
    const subtitleLines = [{ time: 1, text: '第一句' }, { time: 5, text: '第二句' }]
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '循环播放'],
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        getSubtitle: async () => subtitleLines,
      }),
    })
    h.service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', playback: { source: 'baidu', autoSubtitle: true } }),
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{
      lines: Array<{ time: number; text: string }>
    }>
    expect(subs.length).toBeGreaterThanOrEqual(2) // 点歌一次 + 循环一次
    expect(subs[subs.length - 1].lines).toEqual(subtitleLines)
  })

  it('循环播放复用缓存字幕：重新拉取返回 null 也不把字幕覆盖成「暂无字幕」', async () => {
    const subtitleLines = [{ time: 1, text: '第一句' }]
    let calls = 0
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '循环播放'],
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        getSubtitle: async () => {
          calls++
          return calls === 1 ? subtitleLines : null // 第二次（若重新拉）模拟拉取失败
        },
      }),
    })
    h.service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', playback: { source: 'baidu', autoSubtitle: true } }),
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{
      lines: Array<{ time: number; text: string }>
    }>
    expect(subs.length).toBeGreaterThanOrEqual(2)
    expect(subs[subs.length - 1].lines).toEqual(subtitleLines) // 循环仍是原字幕，不是空
    expect(calls).toBe(1) // 循环时不重新调 getSubtitle，直接复用缓存
  })

  it('默认循环/默认音量：网关侧生效，每次新播放带入 loop 与 media.volume', async () => {
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
      }),
    })
    // 显式下发带 defaultLoop / defaultVolume 的 session.start
    h.service.handleText(
      JSON.stringify({
        type: 'session.start',
        sessionId: 's1',
        lang: 'zh-CN',
        playback: { source: 'baidu', autoSubtitle: false, autoLoop: true, defaultLoop: 2, defaultVolume: 0.3 },
      })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ loop?: number }>
    expect(plays).toHaveLength(1)
    // 默认循环次数带入：总共播放 2 遍
    expect(plays[0].loop).toBe(2)
    // 默认音量经 media.volume 下发到客户端（网关侧生效，而非仅存于客户端设置）
    const vol = h.events.find((e) => e.type === 'media.volume') as
      | { type: 'media.volume'; volume: number }
      | undefined
    expect(vol?.volume).toBe(0.3)
    // media.volume 在 media.play 之前下发，保证播放起点即用默认音量
    const volIdx = h.events.findIndex((e) => e.type === 'media.volume')
    const playIdx = h.events.findIndex((e) => e.type === 'media.play')
    expect(volIdx).toBeGreaterThanOrEqual(0)
    expect(volIdx).toBeLessThan(playIdx)
  })

  it('默认循环为 0 / 1：不下发 loop（只播一遍）；默认音量仍经 media.volume 下发', async () => {
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
      }),
    })
    h.service.handleText(
      JSON.stringify({
        type: 'session.start',
        sessionId: 's1',
        lang: 'zh-CN',
        playback: { source: 'baidu', autoSubtitle: false, defaultLoop: 0, defaultVolume: 0.8 },
      })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ loop?: number }>
    expect(plays).toHaveLength(1)
    expect(plays[0].loop).toBeUndefined() // 0 表示不循环，不下发 loop
    const vol = h.events.find((e) => e.type === 'media.volume') as
      | { type: 'media.volume'; volume: number }
      | undefined
    expect(vol?.volume).toBe(0.8)
  })

  it('默认循环/音量可经 session.playback 实时刷新：下次播放才生效', async () => {
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '换一首'],
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        next: async () => ({ url: 'https://bili/b.m4s', title: '七里香', channel: 'bilibili' }),
      }),
    })
    h.service.handleText(
      JSON.stringify({
        type: 'session.start',
        sessionId: 's1',
        lang: 'zh-CN',
        playback: { source: 'baidu', autoSubtitle: false, autoLoop: true, defaultLoop: 1, defaultVolume: 0.5 },
      })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    // 播放中途（换一首前）刷新默认循环为 4、默认音量为 0.2
    h.service.handleText(
      JSON.stringify({ type: 'session.playback', source: 'baidu', autoSubtitle: false, autoLoop: true, defaultLoop: 4, defaultVolume: 0.2 })
    )
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    // 第一次播放：defaultLoop=1（不循环），defaultVolume=0.5
    const firstVol = h.events.filter((e) => e.type === 'media.volume') as Array<{ volume: number }>
    expect(firstVol[0].volume).toBe(0.5)
    // 换一首：应用刷新后的默认（loop=4，volume=0.2）
    const secondPlay = h.events.filter((e) => e.type === 'media.play') as Array<{ loop?: number; title: string }>
    expect(secondPlay).toHaveLength(2)
    expect(secondPlay[1].loop).toBe(4)
    expect(firstVol[1].volume).toBe(0.2)
  })

  it('暂停播放：下发 media.pause（不是 media.stop），不进 LLM', async () => {
    // 用户反馈：说「暂停播放」结果被关掉（误判成 stop）。这条端到端用例走真实
    // finalizeUtterance 路径（带音乐源），验证命中 pause 后下发 media.pause、
    // 绝不发 media.stop，且绕开大模型。
    // 先放一首（让 musicActive=true），再发「暂停播放」——没在播时「暂停」应如实说没有，不下发。
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '暂停播放'],
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/x.m4s', title: 'x', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h) // 播放
    await sleep(30)
    h.playbackDone() // 播完回执，释放排队、允许下一句指令
    await sleep(20)
    await speakUtterance(h) // 暂停
    await sleep(30)

    const pauses = h.events.filter((e) => e.type === 'media.pause')
    const stops = h.events.filter((e) => e.type === 'media.stop')
    expect(pauses).toHaveLength(1)
    expect(stops).toHaveLength(0)
    // 直连绕开 LLM：不应调用 agent
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('已暂停')
  })

  it('暂停播放但当前没在播放：如实说没有，不下发 media.pause、不进 LLM', async () => {
    const h = createHarness({
      finalizeText: '暂停播放',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/x.m4s', title: 'x', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(h.events.filter((e) => e.type === 'media.pause')).toHaveLength(0)
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('现在还没在播放什么')
  })

  /** 桩源：把每次播放/换歌时收到的关键词编码进标题，并随调用递增序号，便于断言“换一首”是否换到不同歌。 */
  function contextSource(): MusicSource {
    let n = 0
    return {
      resolve: async (g) => {
        n += 1
        return { url: 'u', title: `R:${g ?? ''}#${n}`, channel: 'bilibili' }
      },
      next: async (g) => {
        n += 1
        return { url: 'u', title: `N:${g ?? ''}#${n}`, channel: 'bilibili' }
      },
    }
  }

  it('换一首：没指定新偏好时按当前歌手找其它歌（歌名可以不一样），不跳到无关电台', async () => {
    // 用户反馈：播放周杰伦时说“换一首”，结果换了一首和当前无关的歌。
    // 根因：原逻辑把“换一首”收敛成 genre=轻音乐（空泛风格），被路由到 SomaFM 电台（与周杰伦无关）。
    // 修复：bare 换一首用当前歌手（周杰伦）重新搜该歌手的其它作品 → 同歌手、但不同歌名的一首，
    // 而不是拿「周杰伦 稻香」原关键词再搜（那只会命中同名同一首，像没换）。
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '换一首'],
      musicSourceFactory: contextSource,
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    const plays1 = h.events.filter((e) => e.type === 'media.play')
    expect(plays1).toHaveLength(1)
    expect((plays1[0] as { title: string }).title).toContain('周杰伦')
    expect((plays1[0] as { title: string }).title).toContain('稻香')

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)

    const plays2 = h.events.filter((e) => e.type === 'media.play')
    expect(plays2).toHaveLength(2)
    expect((plays2[1] as { title: string }).title).toContain('周杰伦') // 仍是周杰伦（同歌手）
    expect((plays2[1] as { title: string }).title).not.toContain('轻音乐')
    // 换一首给出的是不同的歌（歌名不必一样），不是把「周杰伦 稻香」原样再放一遍
    expect((plays2[1] as { title: string }).title).not.toContain('稻香')
    expect((plays2[1] as { title: string }).title).not.toBe((plays1[0] as { title: string }).title)
  })

  it('换一首：明确指定新歌手时才切到新偏好（如“换首刘德华的”）', async () => {
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '换首刘德华的'],
      musicSourceFactory: contextSource,
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)

    const plays2 = h.events.filter((e) => e.type === 'media.play')
    expect(plays2).toHaveLength(2)
    expect((plays2[1] as { title: string }).title).toContain('刘德华') // 按要求切到刘德华
    expect((plays2[1] as { title: string }).title).not.toContain('周杰伦')
  })

  /** 桩源：模拟「某类型只有一首」（如动画片主题曲），换一首始终换不出不同歌。 */
  function singleTrackSource(): MusicSource {
    return {
      // 点歌与换一首都只返回这一首（同名），触发「换不出不同歌」
      resolve: async (g) =>
        g && /轻音乐|流行|电子|爵士|民谣|古典/.test(g)
          ? { url: 'u', title: `其它风格:${g}`, channel: 'bilibili' }
          : { url: 'u', title: '猪八戒主题曲', channel: 'bilibili' },
      next: async () => ({ url: 'u', title: '猪八戒主题曲', channel: 'bilibili' }),
    }
  }

  it('换一首找不到同类型：反问用户让用户决定（不直接乱播、也不静默），用户说「好」则换其它风格', async () => {
    // 用户反馈：听动画片主题曲（只有一首）说「换一首」毫无反应。
    // 修复：换不出不同歌时不静默、不乱播，而是反问用户要不要换其它风格；
    // 用户确认（好/换其他的）才真的换一首其它风格并口播。
    const h = createHarness({
      finalizeTexts: ['播放天上掉下个猪八戒的主题曲', '换一首', '好'],
      musicSourceFactory: singleTrackSource,
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)

    // 第一首已播
    let plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(1)
    expect((plays[0] as { title: string }).title).toBe('猪八戒主题曲')

    // 换一首：换不出不同歌 → 反问用户，不下发新的 media.play、不进 LLM
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)
    plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(1) // 仍只有第一首，没有乱播
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('没找到同类型的其它内容，要我直接换点别的，还是你自己点名想听的？')

    // 用户说「好」：接受换其它风格 → 真的换一首其它风格并口播
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)
    plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(2)
    expect((plays[1] as { title: string }).title).toContain('其它风格') // 换到了不同的风格
    expect((plays[1] as { title: string }).title).not.toBe('猪八戒主题曲')
    expect(texts(h)).toContain('给你换点别的')
  })

  it('换一首找不到同类型：用户点名想听的（放首刘德华的忘情水）直接按名字播，不强行换风格', async () => {
    // 用户没说「换其他的」，而是指名了一首想听的歌：不应被强行换成风格电台，
    // 而是照常走点歌流程播用户点名的那首。
    const h = createHarness({
      finalizeTexts: ['播放天上掉下个猪八戒的主题曲', '换一首', '放首刘德华的忘情水'],
      musicSourceFactory: () => ({
        resolve: async (g) =>
          g && /刘德华/.test(g)
            ? { url: 'u', title: '刘德华 忘情水', channel: 'bilibili' }
            : { url: 'u', title: '猪八戒主题曲', channel: 'bilibili' },
        next: async () => ({ url: 'u', title: '猪八戒主题曲', channel: 'bilibili' }),
      }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h) // 换一首 → 反问
    await sleep(20)
    let plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(1)
    expect(h.agentCalls()).toBe(0)

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h) // 放首刘德华的忘情水 → 点名
    await sleep(20)
    plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(2)
    expect((plays[1] as { title: string }).title).toContain('刘德华') // 播的是点名的，不是强行换风格
    expect(texts(h)).not.toContain('给你换首其它风格的')
  })

  it('循环播放N遍：复用当前曲下发带 loop 的 media.play，不重新检索、不进 LLM', async () => {
    // 用户要求：播放完继续播放、循环播放（几遍）。验证「循环播放3遍」能复用最近一次曲目，
    // 下发 media.play 且带 loop:3，且不重新检索、不进大模型。
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '循环播放3遍'],
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/daoxiang.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    const plays1 = h.events.filter((e) => e.type === 'media.play') as Array<{ url: string }>
    expect(plays1).toHaveLength(1)
    const firstUrl = plays1[0].url

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)

    const plays2 = h.events.filter((e) => e.type === 'media.play') as Array<{
      url: string
      title: string
      loop?: number
    }>
    expect(plays2).toHaveLength(2)
    const loopPlay = plays2[1]
    expect(loopPlay.loop).toBe(3) // 总共播放 3 遍
    expect(loopPlay.url).toBe(firstUrl) // 复用同一首，不重新检索
    expect(loopPlay.title).toBe('稻香')
    expect(h.agentCalls()).toBe(0) // 直连绕开 LLM
    expect(texts(h)).toContain('循环播放')
  })

  it('循环播放（不带遍数）：按设置里的默认循环次数 3 下发 loop:3，不再写死 2', async () => {
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '循环播放'],
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/daoxiang.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)

    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ loop?: number }>
    expect(plays).toHaveLength(2)
    expect(plays[1].loop).toBe(3) // 没写遍数 → 落到设置里的默认循环次数（defaultLoop 缺省 3）
  })

  it('循环播放但当前没在播：口播提示，不下发 media.play', async () => {
    // 没放过任何曲子时，lastTrack 为空，应友好提示而非报错或乱播。
    const h = createHarness({
      finalizeText: '循环播放3遍',
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/x.m4s', title: 'x', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play')
    expect(plays).toHaveLength(0)
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('还没在播放')
  })

  it('解析失败：仍下发 asr.final，口播「没找到」，绝不出现「操作失败」', async () => {
    const h = createHarness({
      finalizeText: '播放一首不存在的歌',
      // 注入空检索：模拟 MusicBrainz 没结果，验证回退到直接解析并口播「没找到」
      candidateFetcher: async () => ({ ok: true, json: async () => ({ recordings: [] }) }),
      musicSourceFactory: () =>
        playSource(async () => {
          throw new Error('no track')
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const finals = h.events.filter((e) => e.type === 'asr.final') as Array<{ type: 'asr.final'; text: string }>
    expect(finals.some((e) => e.text === '播放一首不存在的歌')).toBe(true)
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(texts(h)).toContain('没找到')
    expect(texts(h)).not.toContain('操作失败')
  })

  /** 把 llm.delta 拼起来，便于断言口播文案（本 describe 未定义共享 texts，这里局部提供）。 */
  function textsOf(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('排队回放的音乐指令走直连拦截（给候选列表），不丢给大模型自动播放', async () => {
    // 用户在助手思考/播报期间说「播放周杰伦的歌」会被排队；排队句回放时必须走
    // 音乐直连拦截（按歌手浏览给候选列表），而不是交给大模型由 play_music 自动播放。
    // 这正是「周杰伦的歌 直接播放了」的根因：排队句此前绕过直连拦截、直奔 LLM。
    const h = createHarness({
      delayDelta: true,
      finalizeTexts: ['你好', '播放周杰伦的歌'],
      candidateFetcher: async () => ({
        ok: true,
        json: async () => ({
          recordings: [
            { title: '稻香', 'artist-credit': [{ name: '周杰伦' }] },
            { title: '晴天', 'artist-credit': [{ name: '周杰伦' }] },
            { title: '七里香', 'artist-credit': [{ name: '周杰伦' }] },
          ],
        }),
      }),
      musicSourceFactory: contextSource,
    })
    await startDialog(h.service)
    await speakUtterance(h) // 「你好」→ 进入思考（processing=true，playbackPending=false）
    expect(h.agentCalls()).toBe(1)

    await speakUtterance(h) // 「播放周杰伦的歌」在思考期到达 → 排队（不进 LLM）
    expect(h.agentCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'asr.queued')).toBe(true)

    h.finishReply() // 思考结束并播报
    await sleep(40)
    h.playbackDone() // 播完回执 → 排队句被回放
    await sleep(40)

    // 排队句走直连拦截：给出候选列表（没直接播、没进 LLM）
    expect(h.agentCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(textsOf(h)).toContain('你想听第几首')
  });
})

describe('字幕开关指令（绕开 LLM）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('语音「关闭字幕」：下发 media.subtitle(close) 收起面板并口播，不进 LLM', async () => {
    // 先放一首带字幕的曲子（让 subtitleActive=true），再「关闭字幕」应如实说已关闭。
    const subtitleLines = [
      { time: 1, text: '第一句' },
      { time: 5, text: '第二句' },
    ]
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '关闭字幕'],
      musicSourceFactory: () => ({
        resolve: async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }),
        getSubtitle: async () => subtitleLines,
      }),
    })
    h.service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', playback: { source: 'baidu', autoSubtitle: true } })
    )
    await sleep(5)
    await speakUtterance(h) // 播放（带字幕）
    await sleep(30)
    h.playbackDone() // 播完回执，释放排队、允许下一句指令
    await sleep(20)
    await speakUtterance(h) // 关闭字幕
    await sleep(30)

    // 有多条 media.subtitle（播放时的自动字幕 + 关闭时的 close），取带 close 的那条
    const close = h.events.find((e) => e.type === 'media.subtitle' && (e as { close?: boolean }).close) as
      | { type: 'media.subtitle'; close?: boolean }
      | undefined
    expect(close).toBeDefined()
    expect(close?.close).toBe(true)
    // 直连指令绕开大模型
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('已关闭字幕')
  })

  it('语音「关闭字幕」但当前本就没有字幕：如实说没有、不谎称已关闭，不进 LLM', async () => {
    const h = createHarness({ finalizeText: '关闭字幕' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 没有正在显示的字幕时也照常下发 close（无害收起），但口播必须如实说「当前没有字幕」，不谎称已关闭
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('当前没有字幕')
  })

  it('语音「开启字幕」：口播开启，不进 LLM', async () => {
    const h = createHarness({ finalizeText: '开启字幕' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{ type: 'media.subtitle'; close?: boolean }>
    // 没有正在播放的曲子时不会下发 close，也不会误发空字幕面板
    expect(subs.some((e) => e.close)).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('已开启字幕')
    // 回归：开启确认只口播一次，不得重复播报两遍
    expect(texts(h).split('已开启字幕').length - 1).toBe(1)
  })
})

describe('播放非歌曲内容时的换内容指令（不一律当「放歌」）', () => {
  function spoken(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('正在播评书时说「换个」：走换内容、不进 LLM、不弹候选列表、不说「没找到这首歌」', async () => {
    const h = createHarness({
      finalizeTexts: ['播放单田芳的张作霖评书', '换个'],
      musicSourceFactory: () => ({
        resolve: async () => ({
          url: 'https://bili/a.m4s',
          title: '单田芳 张作霖 评书 第1回',
          channel: 'bilibili',
        }),
        next: async () => ({
          url: 'https://bili/b.m4s',
          title: '单田芳 张作霖 评书 第2回',
          channel: 'bilibili',
        }),
      }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(30)

    expect(h.events.filter((e) => e.type === 'media.play')).toHaveLength(2)
    expect(h.agentCalls()).toBe(0)
    expect(spoken(h)).toContain('已为你切换到')
    expect(spoken(h)).not.toContain('没找到这首歌')
    expect(spoken(h)).not.toContain('找到几首')
  })
})

describe('播放模式切换指令（绕开 LLM）', () => {
  function spoken(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('「切换播放模式」：下发 client.playMode(toggle)，口播确认，不进 LLM，也不误当点歌', async () => {
    const h = createHarness({ finalizeText: '切换播放模式' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const ev = h.events.find((e) => e.type === 'client.playMode') as
      | { type: 'client.playMode'; mode?: 'float' | 'player' }
      | undefined
    expect(ev).toBeDefined()
    expect(ev?.mode).toBeUndefined()
    // 含「播放」但绝不能被当成点歌下发 media.play
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(spoken(h)).toContain('已切换播放模式')
  })

  it('「换个播放模式」同义说法也能切换', async () => {
    const h = createHarness({ finalizeText: '换个播放模式' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    expect(h.events.some((e) => e.type === 'client.playMode')).toBe(true)
    expect(h.agentCalls()).toBe(0)
  })

  it('明确指定：「打开悬浮」→ mode:float，「关闭悬浮」→ mode:player', async () => {
    const on = createHarness({ finalizeText: '打开悬浮' })
    await startDialog(on.service)
    await speakUtterance(on)
    await sleep(30)
    const evOn = on.events.find((e) => e.type === 'client.playMode') as
      | { type: 'client.playMode'; mode?: 'float' | 'player' }
      | undefined
    expect(evOn?.mode).toBe('float')

    const off = createHarness({ finalizeText: '关闭悬浮' })
    await startDialog(off.service)
    await speakUtterance(off)
    await sleep(30)
    const evOff = off.events.find((e) => e.type === 'client.playMode') as
      | { type: 'client.playMode'; mode?: 'float' | 'player' }
      | undefined
    expect(evOff?.mode).toBe('player')
  })
})

describe('点歌信息不足：候选列表 + 语音选择', () => {
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })

  const mb = (items: Array<{ title: string; artist: string }>) => async () => ({
    ok: true,
    json: async () => ({ recordings: items.map((c) => ({ title: c.title, 'artist-credit': [{ name: c.artist }] })) }),
  })

  const three = [
    { title: '稻香', artist: '周杰伦' },
    { title: '晴天', artist: '周杰伦' },
    { title: '七里香', artist: '周杰伦' },
  ]

  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('只说「周杰伦的歌」：口播编号列表，不直接播、不进 LLM', async () => {
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '周杰伦的歌',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('第一首')
    expect(texts(h)).toContain('第二首')
    expect(texts(h)).toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0) // 还没播，没调 source
    expect(h.events.some((e) => e.type === 'asr.final')).toBe(true)
  })

  it('「列出、念出3首周杰伦的歌」：剔指令/数量词后同样给候选列表（修复误报没找到）', async () => {
    // 用户反馈：说「列出、念出3首周杰伦的歌」结果报「没找到这首歌」。
    // 该句因含「的歌」走播放直连，但检索词若带「列出/念出/3首」会搜不到；
    // 修复后 genreToKeyword 收敛成「周杰伦」，应正常口播编号列表（即用户要的「念出」），
    // 既不报没找到、也不直接播、不进 LLM。
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '列出、念出3首周杰伦的歌',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('第一首')
    expect(texts(h)).toContain('第二首')
    expect(texts(h)).toContain('第三首')
    expect(texts(h)).toContain('你想听第几首')
    expect(texts(h)).not.toContain('没找到')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0)
  })

  it('ASR 句末带标点「周杰伦的歌。」：同样给候选列表，不直接播、不进 LLM', async () => {
    // 真实 ASR 常在句末带标点，之前「歌。」被当成独立实词 → contentWords 长度变 2 → 误判信息充足直接播。
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '周杰伦的歌。',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0)
  })

  it('「来首周杰伦的歌」：给候选列表，不直接播', async () => {
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '来首周杰伦的歌',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0)
  })

  it('检索不到同类型（裸歌手名）时：给「没找到」，不退化成直接播一个裸歌手名', async () => {
    // 候选检索返回 0 条（MusicBrainz 不可达等）：绝不能落到 source.resolve(歌手名) 直接播，
    // 否则既没问用户、又可能播错。应口播「没找到」并中止。
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '周杰伦的歌',
      candidateFetcher: async () => ({ ok: true, json: async () => ({ recordings: [] }) }),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('没找到')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0)
  })

  it('两轮：给列表后说「第二首」→ 播第 2 首，且「我说」卡片显示选择句', async () => {
    const resolved: string[] = []
    const h = createHarness({
      // 带一帧 TTS 让 echoUntil 生效：验证选择判断在回声 guard 之前，
      // 否则「第二首」会被当成刚口播列表的回声丢掉
      ttsFrames: [loudFrame()],
      finalizeTexts: ['周杰伦的歌', '第二首'],
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '晴天', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone() // 释放第一轮列表口播的播完等待
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ title: string }>
    expect(plays.some((p) => p.title === '晴天')).toBe(true)
    // 用「用户核心词 + 选中歌名」去解析，接上严格匹配
    expect(resolved).toContain('周杰伦 晴天')
    const finals = h.events.filter((e) => e.type === 'asr.final') as Array<{ text: string }>
    expect(finals.some((e) => e.text === '第二首')).toBe(true)
  })

  it('列完歌单后插一句无关指令，再说「第二首」仍能选中：候选歌单不被清掉', async () => {
    const resolved: string[] = []
    const h = createHarness({
      finalizeTexts: ['周杰伦的歌', '音量30%', '第二首'],
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '晴天', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    // 中间这句走音量直连，既不选歌也不该把候选歌单清掉
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ title: string }>
    expect(plays.some((p) => p.title === '晴天')).toBe(true)
    expect(resolved).toContain('周杰伦 晴天')
  })

  it('说「第几个」没对上：就地重问、不进 LLM/不播歌，后面再说编号还能选中', async () => {
    const h = createHarness({
      finalizeTexts: ['周杰伦的歌', '第几个', '第二首'],
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '晴天', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)

    const callsBefore = h.agentCalls()
    await speakUtterance(h)
    await sleep(30)
    expect(h.agentCalls()).toBe(callsBefore)
    expect(texts(h)).toContain('没听清选哪首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)

    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)
    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ title: string }>
    expect(plays.some((p) => p.title === '晴天')).toBe(true)
  })

  it('只有 1 个候选：直接播放，不口播列表', async () => {
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '周杰伦',
      candidateFetcher: mb([{ title: '稻香', artist: '周杰伦' }]),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).not.toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
    expect(resolved).toEqual(['周杰伦 稻香'])
  })

  it('候选检索为空：信息充足的歌（歌手+歌名）回退到直接解析（不卡住、不报错）', async () => {
    // 注意：只说了歌手/歌名（信息不足）时检索为空应口播「没找到」、绝不退化成乱播，
    // 见下方「候选检索为空（裸歌手名）」测试；此处只验证「信息充足却搜不到」仍回退直播。
    const h = createHarness({
      finalizeText: '周杰伦的稻香',
      candidateFetcher: mb([]),
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
    expect(texts(h)).toContain('正在为你播放')
  })

  it('歌手+歌名齐全：不走列表，直接播', async () => {
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).not.toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(true)
  })

  it('「再」关掉上下文：正在听周杰伦时点「放稻香」按当前歌手自动播，点「再放稻香」则列清单让用户选', async () => {
    // 用户强调「再」字很关键：带「再」的请求不当成「还是当前歌手的歌」直接播，而是全新请求。
    const h = createHarness({
      finalizeTexts: ['播放周杰伦的稻香', '放稻香', '再放稻香'],
      // 检索「稻香」返回多个歌手版本：有上下文时应只留周杰伦、直接播；带「再」时全部列出让用户选。
      candidateFetcher: mb([
        { title: '稻香', artist: '周杰伦' },
        { title: '稻香', artist: '邓紫棋' },
      ]),
      musicSourceFactory: () =>
        playSource(async (g) => ({
          url: 'https://bili/a.m4s',
          title: String(g ?? '稻香'),
          channel: 'bilibili',
        })),
    })
    await startDialog(h.service)

    // 1) 先建立「正在听周杰伦」的上下文
    await speakUtterance(h)
    await sleep(20)
    expect(h.events.filter((e) => e.type === 'media.play')).toHaveLength(1)

    // 2) 「放稻香」：有上下文 → 自动选周杰伦版本直接播（不列清单）
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)
    expect(h.events.filter((e) => e.type === 'media.play')).toHaveLength(2) // 又直接播了一首
    expect(texts(h)).not.toContain('你想听第几首')

    // 3) 「再放稻香」：带「再」关掉上下文 → 列候选让用户选，不直接播
    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)
    expect(h.events.filter((e) => e.type === 'media.play')).toHaveLength(2) // 没有新增播放
    expect(texts(h)).toContain('你想听第几首')
  })
})

describe('推荐意图：只列候选绝不自动播放', () => {
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })
  const mb = (items: Array<{ title: string; artist: string }>) => async () => ({
    ok: true,
    json: async () => ({ recordings: items.map((c) => ({ title: c.title, 'artist-credit': [{ name: c.artist }] })) }),
  })
  const three = [
    { title: '稻香', artist: '周杰伦' },
    { title: '晴天', artist: '周杰伦' },
    { title: '七里香', artist: '周杰伦' },
  ]
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('「推荐周杰伦的歌」：口播编号列表，绝不自动播放、不进 LLM', async () => {
    const resolved: string[] = []
    const h = createHarness({
      finalizeText: '推荐周杰伦的歌',
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async (g) => {
          resolved.push(String(g))
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('第一首')
    expect(texts(h)).toContain('你想听第几首')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
    expect(resolved).toHaveLength(0)
  })

  it('推荐但没具体歌手/风格：引导补充，不擅自乱播', async () => {
    const h = createHarness({
      finalizeText: '推荐几首歌',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('想听点什么风格')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.agentCalls()).toBe(0)
  })
})

describe('新闻播报直连（绕开 LLM，不被当点歌）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })

  it('「播放新闻」：只有一条候选→直接抽音轨下发 media.play，音乐源在场也不抢', async () => {
    const kws: Array<string | null> = []
    let musicCalls = 0
    const audioUrl = 'https://upos-sz-mirrorcos.bilivideo.com/news-audio.m4s'
    const h = createHarness({
      finalizeText: '播放新闻',
      newsKeywordSpy: (k) => kws.push(k),
      newsHits: [{ bvid: 'BVnews1', title: '三分钟_了解今日新闻联播🔥', cover: 'https://i0.hdslb.com/cover.jpg' }],
      newsAudioUrl: audioUrl,
      musicSourceFactory: () =>
        playSource(async () => {
          musicCalls += 1
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(kws).toEqual([null])
    expect(musicCalls).toBe(0)
    expect(h.agentCalls()).toBe(0)
    const plays = h.events.filter((e) => e.type === 'media.play') as Extract<ServerEvent, { type: 'media.play' }>[]
    expect(plays).toHaveLength(1)
    // 走 music/s 短链（纯 JS 转封装），不是文字合成的 news/s
    expect(plays[0].audioPath).toMatch(/^music\/s\/[0-9a-f]{16}\.aac$/)
    expect(plays[0].cover).toBe('https://i0.hdslb.com/cover.jpg')
    // 标题清洗：无下划线/emoji
    expect(plays[0].title).not.toMatch(/[_🔥]/)
    // 思考态收尾
    expect(h.events.some((e) => e.type === 'llm.done')).toBe(true)
  })

  it('多条候选：列编号让用户选（同音乐），选中后只播一条', async () => {
    const audioUrl = 'https://upos-sz-mirrorcos.bilivideo.com/news-audio.m4s'
    const h = createHarness({
      finalizeTexts: ['播放新闻', '第二条'],
      newsHits: [
        { bvid: 'BV1', title: '今日新闻一' },
        { bvid: 'BV2', title: '今日新闻二', cover: 'https://i0.hdslb.com/cover2.jpg' },
        { bvid: 'BV3', title: '今日新闻三' },
      ],
      newsAudioUrl: audioUrl,
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    // 第一轮应列出候选 + 选择提示，不直接播放
    expect(texts(h)).toContain('找到几条新闻')
    expect(texts(h)).toContain('你想听第几条')
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)

    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)
    const plays = h.events.filter((e) => e.type === 'media.play') as Extract<ServerEvent, { type: 'media.play' }>[]
    expect(plays).toHaveLength(1)
    expect(plays[0].cover).toBe('https://i0.hdslb.com/cover2.jpg')
  })

  it('「科技新闻 / 再放个科技新闻」：带话题词搜索，「再」按全新请求', async () => {
    const kws: Array<string | null> = []
    const h = createHarness({
      finalizeTexts: ['科技新闻', '再放个科技新闻'],
      newsKeywordSpy: (k) => kws.push(k),
      newsHits: [{ bvid: 'BVt', title: '科技新闻播报' }],
      // 抽不到音轨：走兜底口播，便于只断言关键词与话题文案
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)

    expect(kws).toEqual(['科技', '科技'])
    // 抽不到音轨走诚实兜底（标题只作为 display，不口播）
    expect(texts(h)).toContain('现在查不了新闻')
    expect(h.agentCalls()).toBe(0)
  })

  it('「播放新闻歌曲」：不命中新闻，交回音乐候选浏览而非新闻', async () => {
    let newsCalls = 0
    const h = createHarness({
      finalizeText: '播放新闻歌曲',
      newsKeywordSpy: () => { newsCalls += 1 },
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '新闻歌曲', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 「新闻歌曲」被 OTHER_CONTENT 让回下游；不该触发新闻搜索
    expect(newsCalls).toBe(0)
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).not.toContain('现在查不了新闻')
  })

  it('新闻搜索无候选：兜底口播「暂时没查到新闻」，会话不中断', async () => {
    const h = createHarness({ finalizeText: '播放新闻' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(texts(h)).toContain('暂时没查到新闻')
    expect(h.agentCalls()).toBe(0)
  })

  it('新闻播放中「播放下一条」：接着切下一条新闻，不被当成点歌', async () => {
    let musicCalls = 0
    const audioUrl = 'https://upos-sz-mirrorcos.bilivideo.com/news-audio.m4s'
    const h = createHarness({
      finalizeTexts: ['播放新闻', '第二条', '播放下一条'],
      newsHits: [
        { bvid: 'BV1', title: '今日新闻一' },
        { bvid: 'BV2', title: '今日新闻二' },
        { bvid: 'BV3', title: '今日新闻三' },
      ],
      newsAudioUrl: audioUrl,
      musicSourceFactory: () =>
        playSource(async () => {
          musicCalls += 1
          return { url: 'https://bili/a.m4s', title: '稻香', channel: 'bilibili' }
        }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h) // 第二条 → 播「今日新闻二」
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h) // 播放下一条 → 应接着播「今日新闻三」
    await sleep(30)

    const plays = h.events.filter((e) => e.type === 'media.play') as Extract<ServerEvent, { type: 'media.play' }>[]
    expect(plays.map((p) => p.title)).toEqual(['今日新闻二', '今日新闻三'])
    expect(musicCalls).toBe(0)
    expect(h.agentCalls()).toBe(0)
  })

  it('「播放资讯 / 科技资讯」与新闻同义，走新闻视频源', async () => {
    const kws: Array<string | null> = []
    const h = createHarness({
      finalizeTexts: ['播放资讯', '科技资讯'],
      newsKeywordSpy: (k) => kws.push(k),
      newsHits: [{ bvid: 'BVinfo', title: '今日资讯播报' }],
      newsAudioUrl: 'https://upos-sz-mirrorcos.bilivideo.com/info.m4s',
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)

    expect(kws).toEqual([null, '科技'])
    expect(h.events.filter((e) => e.type === 'media.play')).toHaveLength(2)
    expect(h.agentCalls()).toBe(0)
  })
})

describe('择吉日/时间/日期直连（绕开 LLM）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('「推荐个搬家吉日」：扫黄历宜忌直连口播，含农历与阳历，不进 LLM', async () => {
    const h = createHarness({ finalizeText: '推荐个搬家吉日' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const spoken = texts(h)
    expect(spoken).toContain('黄历')
    expect(spoken).toContain('农历')
    expect(spoken).toContain('月')
    expect(h.agentCalls()).toBe(0)
  })

  it('「今天星期几」：报全阳历+星期+农历（只报时分是漏答），不进 LLM', async () => {
    const h = createHarness({ finalizeText: '今天星期几' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const spoken = texts(h)
    expect(spoken).toContain('今天是')
    expect(spoken).toContain('星期')
    expect(spoken).toContain('农历')
    expect(h.agentCalls()).toBe(0)
  })

  it('「现在几点」：只报时分，不带农历日期', async () => {
    const h = createHarness({ finalizeText: '现在几点' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const spoken = texts(h)
    expect(spoken).toContain('现在是')
    expect(spoken).not.toContain('农历')
    expect(h.agentCalls()).toBe(0)
  })

  it('「北京天气怎么样」：走 weather_skill 注入的源口播（指定城市），不进 LLM', async () => {
    const h = createHarness({ finalizeText: '北京天气怎么样' })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const spoken = texts(h)
    expect(spoken).toContain('北京')
    expect(h.agentCalls()).toBe(0)
  })
})

describe('TTS 帧间看门狗（上游挂起不卡死对话链）', () => {
  it('TTS 合成挂起：帧间超时断开本句、tts.end 照常收尾，链继续处理下一句', async () => {
    const h = createHarness({
      finalizeTexts: ['你好，随便聊聊', '你好，聊聊第二个话题'],
      ttsFrames: [loudFrame()],
      ttsStall: true,
      ttsFrameGapMs: 60,
    })
    await startDialog(h.service)
    await speakUtterance(h) // 首句：一帧后上游挂起 → 看门狗 60ms 断开
    h.finishReply() // harness 的 reply 等手动收口；收口后 runAgent 走到 await ttsChain（被看门狗断开）
    await sleep(200)
    // tts.start 发过；看门狗断开后 tts.end 照常下发（客户端播已有帧后回执，链不死）
    expect(h.events.some((e) => e.type === 'tts.start')).toBe(true)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h) // 第二句：processing 已复位，正常进入 agent
    await sleep(60)
    expect(h.agentCalls()).toBe(2)
  })
})

describe('LLM 超时兜底与队列续跑（回归：排队卡死）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }
  it('LLM 超时：发 llm-error mp3 cue（不用 TTS 念兜底），且会话不卡死能接受下一轮', async () => {
    const h = createHarness({
      delayDelta: true, // agent 挂起，50ms 超时触发失败路径
      finalizeTexts: ['你好，随便聊聊', '你好，聊聊第二个话题'],
      ttsFrames: [loudFrame()],
      llmTimeoutMs: 50,
    })
    await startDialog(h.service)
    await speakUtterance(h) // 首句 → LLM 超时 → 失败路径
    await sleep(150)

    // LLM 失败兜底改为 client.cue('llm-error')（本地 mp3），因为 TTS 可能也坏了
    expect(h.events.some((e) => e.type === 'client.cue' && (e as Extract<ServerEvent, { type: 'client.cue' }>).cue === 'llm-error')).toBe(true)
    // 不发 TTS 兜底文案（旧行为是 llmUnavailable 文本）
    expect(texts(h)).not.toContain('这边一时没接上，你稍后再问我一次好吗？')

    // 关键：会话不卡死——下一轮说话仍能触发 agent（queue/processing 没被卡住）
    await speakUtterance(h)
    await sleep(150)
    expect(h.agentCalls()).toBe(2)
  })
})

describe('插话草稿下发（与思考/播报并存展示）', () => {
  function partials(h: Harness): string[] {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'asr.partial' }> => e.type === 'asr.partial')
      .map((e) => e.text)
  }

  it('播报中用户插话草稿照常下发（识别能显示出来），助手原话回声草稿被抑制', async () => {
    // 先播一句：finishReply 进入播报（playbackPending=true、spoken 已记录口播原文）
    const h = createHarness({
      delayDelta: true,
      finalizeText: '你好，随便聊聊',
      replyText: '好的，我来说一句。',
      ttsFrames: [loudFrame()],
      partialText: '我想问下一个问题',
    })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    // 播报期间上行一帧：草稿是用户插话（非口播原文）→ 放行下发，界面可与播报并存显示
    h.service.handleBinary(loudFrame())
    await sleep(10)
    expect(partials(h)).toContain('我想问下一个问题')

    const h2 = createHarness({
      delayDelta: true,
      finalizeText: '你好，随便聊聊',
      replyText: '好的，我来说一句。',
      ttsFrames: [loudFrame()],
      partialText: '好的，我来说一句',
    })
    await startDialog(h2.service)
    await speakUtterance(h2)
    h2.finishReply()
    await sleep(40)
    h2.service.handleBinary(loudFrame())
    await sleep(10)
    expect(partials(h2)).toHaveLength(0)
  })

  it('播报期正常音量（非大喊）插话也能下发草稿——说话当下能显示文字', async () => {
    // 用户可见行为回归：播报期说一句正常音量（非 loudFrame 大喊）的插话，必须下发
    // asr.partial 让客户端显示识别草稿。曾因播报期用 strict VAD 抬高门槛，正常音量
    // 进不了 ASR、没有草稿文字，用户体感「播报时很难插话」。
    const h = createHarness({
      delayDelta: true,
      finalizeText: '你好，随便聊聊',
      replyText: '好的，我来说一句。',
      ttsFrames: [loudFrame()],
      partialText: '停一下',
    })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    // 让 VAD 退出上一句的 voiced 状态，确保这里测的是「新开口第一帧」
    await sleep(900)
    h.service.handleBinary(silentFrame())

    // 两帧正常音量插话（VAD 需连续 2 帧确认开口）→ 下发草稿
    h.service.handleBinary(normalFrame())
    h.service.handleBinary(normalFrame())
    await sleep(10)
    expect(partials(h)).toContain('停一下')
  })
})

describe('音量控制直连命令（绕开 LLM）', () => {
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })

  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  function volumes(h: Harness): number[] {
    return (h.events.filter((e) => e.type === 'media.volume') as Array<{ type: 'media.volume'; volume: number }>).map(
      (e) => e.volume
    )
  }

  it('「音量30%」：下发 media.volume=0.3，口播「已为您将音量调到 30%」，不进 LLM', async () => {
    const h = createHarness({
      finalizeText: '音量30%',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(volumes(h)).toEqual([0.3])
    expect(texts(h)).toContain('已为您将音量调到 30%。')
    expect(h.agentCalls()).toBe(0)
  })

  it('「调大音量」：在当前 0.5 基础上 +10% → 0.6，口播「已调大，当前音量 60%」', async () => {
    const h = createHarness({
      finalizeText: '调大音量',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(volumes(h)).toEqual([0.6])
    expect(texts(h)).toContain('已调大，当前音量 60%。')
  })

  it('「调小音量」：0.5 -10% → 0.4，口播「已调小，当前音量 40%」', async () => {
    const h = createHarness({
      finalizeText: '调小音量',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(volumes(h)).toEqual([0.4])
    expect(texts(h)).toContain('已调小，当前音量 40%。')
  })

  it('已到最大再调大：提示「已经最大了」，不下发 media.volume', async () => {
    const h = createHarness({
      finalizeText: '调大音量',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    // 客户端先回执当前音量已是最大（1.0），网关同步
    h.service.handleText(JSON.stringify({ type: 'music.volume', volume: 1 }))
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    expect(volumes(h)).toEqual([])
    expect(texts(h)).toContain('音量已经最大了。')
  })

  it('已到最小再调小：提示「已经最小了」，不下发 media.volume', async () => {
    const h = createHarness({
      finalizeText: '调小音量',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    h.service.handleText(JSON.stringify({ type: 'music.volume', volume: 0 }))
    await sleep(5)
    await speakUtterance(h)
    await sleep(30)

    expect(volumes(h)).toEqual([])
    expect(texts(h)).toContain('音量已经最小了。')
  })

  it('「再减 / 再增」仍相对增减（复用 decrease/increase）', async () => {
    const h = createHarness({
      finalizeText: '再减',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/a.m4s', title: 'a', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)
    expect(volumes(h)).toEqual([0.4])
    expect(texts(h)).toContain('已调小，当前音量 40%。')
  })
})

describe('说话被切断（句末端点过激）', () => {

  it('句中短停顿：一次说话中途停顿仍定稿为一整段，不被切成两段', async () => {
    const h = createHarness({ asrEndpointMs: 800, finalizeText: '我今天想出去玩' })
    await startDialog(h.service)
    // 前半句
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    // 自然思考停顿 400ms（< endpointMs 800）：不应提前定稿
    await sleep(400)
    expect(h.events.filter((e) => e.type === 'asr.final')).toHaveLength(0)
    // 继续后半句（停顿 < 800ms 内续上，端点计时被重置）
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    // 等句末定稿（endpointMs 800 + 余量）
    await sleep(900)
    // 整句只定稿一次，没有被切成「前一段 / 后一段」
    const finals = h.events.filter((e) => e.type === 'asr.final')
    expect(finals).toHaveLength(1)
  })

  it('长句含多处停顿（endpointMs=2500，当前线上配置）：整体定稿一次，不被切成多段', async () => {
    // 复现用户“唤醒后说长句”的场景：一句带多处自然停顿的长话，停顿都 < 2500ms，
    // 应整体定稿为一整段交给大模型；之前 endpointMs=700 会把长句切碎（像失忆）。
    const h = createHarness({
      asrEndpointMs: 2500,
      finalizeText: '帮我记一下，明天上午十点健身，下午三点开会',
    })
    await startDialog(h.service)
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(600) // 自然停顿 600ms（< 2500），不应提前定稿
    expect(h.events.filter((e) => e.type === 'asr.final' || e.type === 'asr.queued')).toHaveLength(0)
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(600)
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    // 句末停顿 > 2500ms，整句只定稿一次（不论 final 还是 queued 都算一段）
    await sleep(3000)
    const segments = h.events.filter((e) => e.type === 'asr.final' || e.type === 'asr.queued')
    expect(segments).toHaveLength(1)
  })

  it('endpointMs=700（旧误设值）：句中停顿把长句切成多段（失忆根因）', async () => {
    // 复现用户反馈的“只识别前一段”：停顿一超过 700ms 就定稿，长句被切碎成多轮。
    const h = createHarness({
      asrEndpointMs: 700,
      finalizeText: '帮我记一下，明天上午十点健身，下午三点开会',
    })
    await startDialog(h.service)
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(900) // > 700：第一段在此被定稿（切断）
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(900) // > 700：又定稿一段
    for (let i = 0; i < 5; i += 1) h.service.handleBinary(loudFrame())
    await sleep(1500) // 句末定稿
    // 长句被切成多段（final + queued 合计 >= 2）
    const segments = h.events.filter((e) => e.type === 'asr.final' || e.type === 'asr.queued')
    expect(segments.length).toBeGreaterThanOrEqual(2)
  })
})

describe('会话与连接解耦：重武装（deviceId 复用不丢记忆）', () => {
  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })
  const mb = (items: Array<{ title: string; artist: string }>) => async () => ({
    ok: true,
    json: async () => ({ recordings: items.map((c) => ({ title: c.title, 'artist-credit': [{ name: c.artist }] })) }),
  })
  const three = [
    { title: '稻香', artist: '周杰伦' },
    { title: '晴天', artist: '周杰伦' },
    { title: '七里香', artist: '周杰伦' },
  ]

  /** 说完一句并等句末定稿（按 800ms 端点阈值留足时间），随后释放播放回执并等播报结束。
   *  必须等 playbackPending 回落，否则下一句会落在「播报中」分支被当回声/忽略。 */
  async function speakSettle(h: Harness): Promise<void> {
    await speakUtterance(h)
    await sleep(900)
    h.playbackDone()
    await sleep(60)
  }

  it('二次 start（重唤醒/重连）走 re-arm：不重建 agent、保留候选歌单', async () => {
    const h = createHarness({
      asrEndpointMs: 800,
      ttsFrames: [loudFrame()],
      finalizeTexts: ['周杰伦的歌', '第二首'],
      candidateFetcher: mb(three),
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '晴天', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    expect(h.agentFactoryCalls()).toBe(1) // 首次 start 构造了智能体

    await speakSettle(h) // 给候选列表（周杰伦的歌）
    h.playbackDone()
    await sleep(20)

    // 二次 start（模拟设备重唤醒/断线重连）：应走 re-arm
    await startDialog(h.service)
    expect(h.agentFactoryCalls()).toBe(1) // 没有重建智能体，记忆保留

    await speakSettle(h) // 回答「第二首」
    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ title: string }>
    // 候选歌单仍在：第二首选中晴天，说明 re-arm 没清空 pendingCandidates
    expect(plays.some((p) => p.title === '晴天')).toBe(true)
    // 候选选择不进 LLM
    expect(h.agentCalls()).toBe(0)
  })

  it('session.end 之后 start 视为全新：重建 agent，旧记忆不保留', async () => {
    // 用普通对话（非音乐/候选流程）验证，避免播报时序与候选分支相互干扰
    const h = createHarness({ asrEndpointMs: 800, finalizeText: '你好' })
    await startDialog(h.service)
    expect(h.agentFactoryCalls()).toBe(1)

    await speakSettle(h) // 一轮普通对话
    expect(h.agentCalls()).toBe(1) // 首轮进了 LLM

    // 显式结束会话（客户端 close 走 session.end）
    h.service.handleText(JSON.stringify({ type: 'session.end' }))
    await sleep(20)
    expect(h.agentFactoryCalls()).toBe(1) // 结束未重建

    // 再次 start：全新会话，智能体重新构造
    await startDialog(h.service)
    expect(h.agentFactoryCalls()).toBe(2)

    // 全新会话：再说一句普通对话，agent 被重建且可用
    await speakSettle(h)
    expect(h.agentCalls()).toBe(2)
  })
})

describe('重武装切来源重建 agent（让「切换来源/音色」立即生效）', () => {
  /**
   * 按 voice.provider 返回不同的 llm 配置指纹：builtin 与 dashscope 必须产出不同的 llmKey
   * （JSON.stringify(resolved.llm)），从而让 start() 在 re-arm 时识别出「来源变了」并重建 agent。
   * 若某次 resolve 出的 llm 与上次相同（例如只换了音色、provider 没变），llmKey 不变，不重建。
   */
  function resolveByProvider(voice?: unknown): ResolvedCapabilities {
    const provider =
      voice && typeof voice === 'object' && (voice as { provider?: string }).provider === 'dashscope'
        ? 'dashscope'
        : 'builtin'
    if (provider === 'dashscope') {
      return {
        llm: { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen', apiKey: 'sk' },
        asr: { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk' },
        tts: { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk' },
      } as unknown as ResolvedCapabilities
    }
    return {
      llm: { provider: 'builtin', baseUrl: 'http://127.0.0.1:9529/llm/v1', model: '' },
      asr: { provider: 'builtin', baseUrl: 'http://127.0.0.1:9529/voice' },
      tts: { provider: 'builtin', baseUrl: 'http://127.0.0.1:9529/voice' },
    } as unknown as ResolvedCapabilities
  }

  /** 携带指定 voice 的 session.start（不带 voice 即视为内置）。 */
  async function startWithVoice(service: VoiceSessionService, voice?: unknown): Promise<void> {
    service.handleText(
      JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN', ...(voice ? { voice } : {}) })
    )
    await sleep(5)
  }

  /** 说完一句并等句末定稿、释放播完回执（本 describe 内复用）。 */
  async function settle(h: Harness): Promise<void> {
    await speakUtterance(h)
    await sleep(900)
    h.playbackDone()
    await sleep(60)
  }

  it('首次 start 构造 agent；同来源 re-arm 保留 agent（factoryCalls 不增）', async () => {
    const h = createHarness({ asrEndpointMs: 800, resolveVoice: resolveByProvider })
    await startWithVoice(h.service, { provider: 'builtin' })
    expect(h.agentFactoryCalls()).toBe(1)

    // 同来源（builtin）再次 start：走 re-arm，保留原 agent，不重建
    await startWithVoice(h.service, { provider: 'builtin' })
    expect(h.agentFactoryCalls()).toBe(1)

    // 原 agent 仍可用：再说一句普通对话能正常进 LLM
    await settle(h)
    expect(h.agentCalls()).toBe(1)
  })

  it('re-arm 切到 DashScope：重建 agent（factoryCalls 增 1），切换来源立即生效', async () => {
    const h = createHarness({ asrEndpointMs: 800, resolveVoice: resolveByProvider })
    await startWithVoice(h.service, { provider: 'builtin' })
    expect(h.agentFactoryCalls()).toBe(1)

    // 切到 DashScope：llm 指纹变了，必须重建 agent
    await startWithVoice(h.service, { provider: 'dashscope', apiKey: 'sk-test' })
    expect(h.agentFactoryCalls()).toBe(2)

    // 仍是 DashScope 再次 re-arm：指纹没变，不再重建
    await startWithVoice(h.service, { provider: 'dashscope', apiKey: 'sk-test' })
    expect(h.agentFactoryCalls()).toBe(2)

    // 重建后的 agent 仍可用
    await settle(h)
    expect(h.agentCalls()).toBe(1)
  })

  it('re-arm 切回 builtin：再次重建 agent（factoryCalls 再增 1）', async () => {
    const h = createHarness({ asrEndpointMs: 800, resolveVoice: resolveByProvider })
    await startWithVoice(h.service, { provider: 'builtin' })
    await startWithVoice(h.service, { provider: 'dashscope', apiKey: 'sk-test' })
    expect(h.agentFactoryCalls()).toBe(2)

    // 切回 builtin：指纹又变，再次重建
    await startWithVoice(h.service, { provider: 'builtin' })
    expect(h.agentFactoryCalls()).toBe(3)
  })

  it('仅改音色（同 provider）：llm 指纹未变，不重建 agent', async () => {
    // 音色变化落在 tts params 上，provider/baseUrl/model 不变 → llmKey 不变 → 不重建 LLM agent。
    // 这正好验证「音色换了声音没变」的修复点在「客户端 re-arm 触发 + start() 每次无条件重建 tts 实例」，
    // 而非每次都重建整个 agent（那会丢掉在途对话）。
    const h = createHarness({ asrEndpointMs: 800, resolveVoice: resolveByProvider })
    await startWithVoice(h.service, { provider: 'dashscope', apiKey: 'sk', params: { voice: 'xiaoxiao' } })
    expect(h.agentFactoryCalls()).toBe(1)
    await startWithVoice(h.service, { provider: 'dashscope', apiKey: 'sk', params: { voice: 'yunxi' } })
    expect(h.agentFactoryCalls()).toBe(1) // 同来源，未重建 agent
  })
})

describe('长期记忆：语音「忘了XX」直连 + 系统提示注入', () => {
  /** 说完一句并等句末定稿、释放播完回执（本 describe 内复用）。 */
  async function settle(h: Harness): Promise<void> {
    await speakUtterance(h)
    await sleep(900)
    h.playbackDone()
    await sleep(60)
  }

  it('「忘了我的作息」直接落地 forget 并口播确认，不进 LLM', async () => {
    const h = createHarness({ asrEndpointMs: 800, finalizeText: '忘了我的作息' })
    await startDialog(h.service)
    await settle(h)
    // 未经过 LLM（agent.reply 没被调用）
    expect(h.agentCalls()).toBe(0)
    // 记忆直连命令落地
    const calls = h.forgetCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].topic).toBe('我的作息')
    // 下发了 asr.final（我说卡片）与 tts 确认
    expect(h.events.some((e) => e.type === 'asr.final')).toBe(true)
    expect(h.events.some((e) => e.type === 'tts.start')).toBe(true)
  })

  it('「清空记忆」清空全部（topic 为空）', async () => {
    const h = createHarness({ asrEndpointMs: 800, finalizeText: '清空记忆' })
    await startDialog(h.service)
    await settle(h)
    expect(h.agentCalls()).toBe(0)
    const calls = h.forgetCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].topic).toBeUndefined()
  })

  it('「我忘了带钥匙」这种陈述不触发记忆删除（走正常 LLM 路径）', async () => {
    const h = createHarness({
      asrEndpointMs: 800,
      // 走正常 LLM 路径，agent.reply 会被调用；用较长句避免被「裸点歌」误判
      finalizeText: '我忘了带钥匙你能提醒我一下吗',
    })
    await startDialog(h.service)
    await settle(h)
    expect(h.agentCalls()).toBe(1)
    expect(h.forgetCalls()).toHaveLength(0)
  })

  it('全新会话把该设备记忆注入系统提示（memoryContext 非空）', async () => {
    const h = createHarness({
      asrEndpointMs: 800,
      memories: [
        { key: '作息', value: '晚上 12 点睡', updatedAt: 1 },
        { key: '喜欢的音乐', value: '周杰伦', updatedAt: 2 },
      ],
    })
    await startDialog(h.service)
    const ctx = h.lastMemoryContext()
    expect(ctx).toBeDefined()
    expect(ctx).toContain('作息')
    expect(ctx).toContain('周杰伦')
  })

  it('re-arm（二次 start）保留原 agent，memoryContext 不再重建但仍可用', async () => {
    const h = createHarness({
      asrEndpointMs: 800,
      memories: [{ key: '作息', value: '晚 12 点', updatedAt: 1 }],
    })
    await startDialog(h.service)
    const firstCtx = h.lastMemoryContext()
    expect(firstCtx).toContain('作息')
    // 二次 start（重唤醒/重连）
    await startDialog(h.service)
    // 没有重建 agent（agentFactory 仍只调用一次），memoryContext 沿用首轮
    expect(h.agentFactoryCalls()).toBe(1)
  })

  it('无 deviceId 时不为记忆注册工具/注入（memoryContext 为空）', async () => {
    const h = createHarness({ asrEndpointMs: 800, deviceId: null })
    await startDialog(h.service)
    expect(h.lastMemoryContext()).toBeUndefined()
  })
})

describe('懒加载定位：client.location.request 下发与 session.location 兑现', () => {
  it('会话暂无位置时下发请求，客户端上报后兑现 promise', async () => {
    const h = createHarness({ asrEndpointMs: 800 })
    await startDialog(h.service) // session.start 不带 location
    const p = (h.service as unknown as { requestClientLocation: () => Promise<unknown> }).requestClientLocation()
    // 立即应下发 client.location.request，且只下发一次
    expect(h.events.some((e) => e.type === 'client.location.request')).toBe(true)
    const before = h.events.filter((e) => e.type === 'client.location.request').length
    // 并发再要一次位置：不应重复下发请求
    const p2 = (h.service as unknown as { requestClientLocation: () => Promise<unknown> }).requestClientLocation()
    expect(h.events.filter((e) => e.type === 'client.location.request').length).toBe(before)
    // 客户端上报位置
    h.service.handleText(
      JSON.stringify({ type: 'session.location', latitude: 22.54, longitude: 114.06, address: '深圳市南山区' })
    )
    const loc = (await p) as { latitude: number; longitude: number; address?: string }
    await p2
    expect(loc.latitude).toBe(22.54)
    expect(loc.longitude).toBe(114.06)
    expect(loc.address).toBe('深圳市南山区')
  })

  it('超时（8s）未上报时兑现为 null，工具回退到「位置不可用」', async () => {
    const h = createHarness({ asrEndpointMs: 800 })
    await startDialog(h.service)
    const loc = await (h.service as unknown as { requestClientLocation: () => Promise<unknown> }).requestClientLocation()
    expect(loc).toBeNull()
  })
})


describe('建连即不可用时下发提示音（client.cue）', () => {
  function downReport(over: Partial<HealthReport> = {}): HealthReport {
    return {
      asr: { provider: 'whisper', configured: true, reachable: false, message: 'down' },
      llm: { provider: 'ollama', configured: true, reachable: false, message: 'down' },
      tts: { provider: 'edge', configured: true, reachable: false, message: 'down' },
      network: { reachable: false, message: 'down' },
      ...over,
    }
  }

  it('ASR/TTS/LLM 全不可达：会话 start 后下发对应 client.cue', async () => {
    const h = createHarness({ capabilityProbe: async () => downReport() })
    await startDialog(h.service)
    await sleep(10)
    const cues = h.events.filter((e) => e.type === 'client.cue') as Array<{ type: 'client.cue'; cue: string }>
    expect(cues.map((c) => c.cue).sort()).toEqual(['asr-down', 'llm-down', 'network-down', 'tts-down'])
  })

  it('全部就绪：不下发任何 client.cue', async () => {
    const h = createHarness({
      capabilityProbe: async () => ({
        asr: { provider: 'whisper', configured: true, reachable: true, message: 'ok' },
        llm: { provider: 'ollama', configured: true, reachable: true, message: 'ok' },
        tts: { provider: 'edge', configured: true, reachable: true, message: 'ok' },
        network: { reachable: true, message: 'ok' },
      }),
    })
    await startDialog(h.service)
    await sleep(10)
    expect(h.events.some((e) => e.type === 'client.cue')).toBe(false)
  })

  it('仅 ASR 不可达：只下发 asr-down', async () => {
    const h = createHarness({
      capabilityProbe: async () => ({
        asr: { provider: 'whisper', configured: true, reachable: false, message: 'down' },
        llm: { provider: 'ollama', configured: true, reachable: true, message: 'ok' },
        tts: { provider: 'edge', configured: true, reachable: true, message: 'ok' },
        network: { reachable: true, message: 'ok' },
      }),
    })
    await startDialog(h.service)
    await sleep(10)
    const cues = h.events.filter((e) => e.type === 'client.cue') as Array<{ type: 'client.cue'; cue: string }>
    expect(cues.map((c) => c.cue)).toEqual(['asr-down'])
  })
})

describe('大模型异常回复兜底：不念垃圾，给一句兜底口播', () => {
  it('整句都是泄漏控制符（thought <channel|>）：不当作正文念，改口播兜底', async () => {
    const h = createHarness({ replyText: 'thought\n<channel|>' })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(10)
    h.playbackDone()
    await sleep(10)

    const delta = h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
    // 泄漏标记绝不能下发给客户端/被念出来
    expect(delta).not.toContain('thought')
    expect(delta).not.toContain('channel')
    // 而是给一句兜底，让用户能自然重说
    expect(delta).toContain('抱歉，我刚才没反应过来')
    // 兜底也走 TTS 链路（有 tts.start），不是静默丢弃
    expect(h.events.some((e) => e.type === 'tts.start')).toBe(true)
  })

  it('泄漏标记后跟正常正文：只播放正常部分，不念垃圾', async () => {
    const h = createHarness({ replyText: 'thought\n<channel|>\n好的，已为您播放。' })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(10)
    h.playbackDone()
    await sleep(10)

    const delta = h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
    expect(delta).not.toContain('thought')
    expect(delta).not.toContain('channel')
    expect(delta).toContain('好的，已为您播放。')
  })
})

describe('播放源实时切换（session.playback）', () => {
  /** 与直连命令用例同款的轻量源工厂：resolve 返回带 kind 标记的曲目，便于断言用的是哪个源 */
  const kindSource = (kind: string): MusicSource => ({
    resolve: async () => ({ url: `https://x/${kind}`, title: `歌-${kind}`, channel: kind }),
  })

  function lastPlayTitle(h: Harness, after: number): string | undefined {
    const plays = h.events.slice(after).filter((e) => e.type === 'media.play') as Array<{
      type: 'media.play'
      url: string
      title: string
      channel?: string
    }>
    return plays[plays.length - 1]?.title
  }

  it('设置页保存后无需重连：session.playback 立刻让下一句点歌走新源', async () => {
    // 工厂按可变 kind 返回不同源，模拟「客户端改了设置 → 网关用新源」
    let kind = 'baidu'
    const h = createHarness({
      finalizeText: '播放周杰伦的稻香',
      musicSourceFactory: () => kindSource(kind),
    })
    await startDialog(h.service)

    await speakUtterance(h)
    await sleep(30)
    expect(lastPlayTitle(h, 0)).toBe('歌-baidu')
    h.playbackDone()
    await sleep(10)

    // 模拟设置页 onSave：切到另一个源并下发 session.playback（工厂按可变 kind 返回不同源）
    kind = 'custom'
    h.service.handleText(JSON.stringify({ type: 'session.playback', source: 'custom' }))
    await sleep(5)

    const before = h.events.length
    await speakUtterance(h)
    await sleep(30)
    expect(lastPlayTitle(h, before)).toBe('歌-custom')
    // 全程没进 LLM（直连点歌）
    expect(h.agentCalls()).toBe(0)
  })
})

/**
 * 英文会话（en-US 带地区码）下三类列表的「没听清编号」重问文案必须本地化。
 * 特别锁住 music.chooseAgain：英文目录原来靠 ...zhCN.music 展开，没覆盖就会冒中文。
 * 用越界编号「9」触发重问——像在报编号但没对上，列表只有 2~3 条。
 */
describe('英文会话：选号重问文案本地化', () => {
  function spoken(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  const playSource = (resolve: MusicSource['resolve']): MusicSource => ({ resolve })
  const mb = (items: Array<{ title: string; artist: string }>) => async () => ({
    ok: true,
    json: async () => ({
      recordings: items.map((c) => ({ title: c.title, 'artist-credit': [{ name: c.artist }] })),
    }),
  })
  const songs = [
    { title: '稻香', artist: '周杰伦' },
    { title: '晴天', artist: '周杰伦' },
    { title: '七里香', artist: '周杰伦' },
  ]
  const items = [
    { title: '商品A', price: '9.9元', mall: '京东', tags: [], link: 'https://x/a' },
    { title: '商品B', price: '20元', mall: '天猫', tags: [], link: 'https://x/b' },
  ]

  it('音乐候选：en-US 说越界编号 → 英文重问，且不冒中文继承文案', async () => {
    const h = createHarness({
      finalizeTexts: ['周杰伦的歌', '9'],
      candidateFetcher: mb(songs),
      musicSourceFactory: () =>
        playSource(async () => ({ url: 'https://bili/a.m4s', title: '晴天', channel: 'bilibili' })),
    })
    await startDialog(h.service, 'en-US')
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    await speakUtterance(h)
    await sleep(30)

    expect(spoken(h)).toContain("Didn't catch which song")
    expect(spoken(h)).not.toContain('没听清选哪首')
    expect(h.agentCalls()).toBe(0)
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
  })

  it('商品列表：en-US 说越界编号 → 英文重问', async () => {
    const h = createHarness({
      finalizeTexts: ['有什么折扣', '9'],
      dealsQuery: async () => ({ text: '查到 2 件最新好价', deals: items }),
    })
    await startDialog(h.service, 'en-US')
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    const before = h.agentCalls()
    await speakUtterance(h)
    await sleep(30)

    expect(spoken(h)).toContain("Didn't catch which item")
    expect(spoken(h)).not.toContain('没听清是第几件')
    expect(h.agentCalls()).toBe(before)
  })

})

describe('语音会话：自动记忆（抽取 + 摘要）', () => {
  it('自动记忆关闭时，普通对话轮次不触发抽取', async () => {
    const h = createHarness()
    // 不带 memory.auto，缺省关
    await startDialogWithMemory(h.service, false)
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)
    h.playbackDone()
    await sleep(30)
    expect(h.extractCalls()).toBe(0)
    expect(h.savedMemories()).toHaveLength(0)
  })

  it('自动记忆开启时，普通对话轮次触发抽取并把结果落库', async () => {
    const h = createHarness()
    await startDialogWithMemory(h.service, true)
    h.setExtractResult([{ key: '作息', value: '七点起床' }])
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)
    h.playbackDone()
    await sleep(50)
    expect(h.extractCalls()).toBeGreaterThan(0)
    // 抽取上下文至少包含本轮用户原话
    const last = h.lastExtractHistory().at(-1) ?? []
    expect(last.some((t) => t.includes('随便聊聊'))).toBe(true)
    expect(h.savedMemories()).toContainEqual({ key: '作息', value: '七点起床' })
  })

  it('无值得记的内容时（抽取返回空）不写库', async () => {
    const h = createHarness()
    await startDialogWithMemory(h.service, true)
    h.setExtractResult([])
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)
    h.playbackDone()
    await sleep(50)
    expect(h.extractCalls()).toBeGreaterThan(0)
    expect(h.savedMemories()).toHaveLength(0)
  })

  it('直连命令（音乐）轮次不触发自动抽取', async () => {
    const h = createHarness({
      // 定稿为明确音乐指令，走直连、不进大模型
      finalizeText: '放一首周杰伦的歌',
    })
    await startDialogWithMemory(h.service, true)
    await speakUtterance(h)
    await sleep(30)
    h.playbackDone()
    await sleep(30)
    expect(h.extractCalls()).toBe(0)
    expect(h.savedMemories()).toHaveLength(0)
  })

  it('合并（摘要）阈值/频率可由配置覆盖：阈值降到 0、频率 1 时每轮抽取都触发合并', async () => {
    const h = createHarness({ consolidateThreshold: 0, consolidateEvery: 1 })
    await startDialogWithMemory(h.service, true)
    h.setExtractResult([{ key: '作息', value: '七点起床' }])
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)
    h.playbackDone()
    await sleep(50)
    expect(h.extractCalls()).toBeGreaterThan(0)
    // 阈值 0 且频率 1：每轮都满足合并条件 → 合并（摘要）至少被调用一次
    expect(h.consolidateCalls()).toBeGreaterThan(0)
  })

  it('合并阈值/频率可由 session.start.memory 逐会话覆盖（不依赖网关配置）', async () => {
    // 不注入 deps 配置，改用 session.start 的 memory 字段下发阈值/频率
    const h = createHarness()
    h.service.handleText(
      JSON.stringify({
        type: 'session.start',
        sessionId: 's1',
        lang: 'zh-CN',
        memory: { auto: true, consolidateThreshold: 0, consolidateEvery: 1 },
      })
    )
    await sleep(5)
    h.setExtractResult([{ key: '作息', value: '七点起床' }])
    await speakUtterance(h)
    h.finishReply()
    await sleep(20)
    h.playbackDone()
    await sleep(50)
    expect(h.extractCalls()).toBeGreaterThan(0)
    expect(h.consolidateCalls()).toBeGreaterThan(0)
  })
})

describe('语音会话：音频下发计数（回归：不重复播放）', () => {
  it('一轮用户对话只下发一次 tts.start', async () => {
    const h = createHarness({ ttsFrames: [loudFrame(), loudFrame()] })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    // 回归：一轮对话只能有一次 tts.start；多次说明服务端把同一轮回复发了两遍，
    // 客户端会因此把同一句 TTS 放两遍。
    expect(h.events.filter((e) => e.type === 'tts.start')).toHaveLength(1)
  })

  it('一句语音指令只触发一次回复（agent 不被调用两次）', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.agentCalls()).toBe(1)
  })
})

describe('百科查询直连（绕开 LLM，助手框显示 + 播报）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('「百科李存勖」：走百度音频 media.play，助手框只显示播报确认、全文进字幕', async () => {
    let queried = ''
    let audioText = ''
    const h = createHarness({
      finalizeText: '百科李存勖',
      baikeQuerySpy: (q) => { queried = q },
      baikeQuery: async (q) => ({
        entry: {
          title: '李存勖',
          summary: '五代后唐开国皇帝，军事才能出众。',
          image: 'https://bkimg.cdn.bcebos.com/smart/xxx',
        },
        text: `李存勖：五代后唐开国皇帝，军事才能出众。（查：${q}）`,
      }),
      baikeAudioUrl: async (t) => { audioText = t; return 'https://tts.baidu.com/audio.mp3' },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(queried).toBe('李存勖')
    expect(audioText).toContain('五代后唐开国皇帝')
    // 助手框只显示简短播报确认，不显示百科全文（全文进字幕面板逐句展示）
    expect(texts(h)).toContain('正在为你播报')
    expect(texts(h)).not.toContain('五代后唐开国皇帝')
    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ url: string; title: string; cover?: string; source?: string }>
    expect(plays.length).toBe(1)
    expect(plays[0].url).toBe('https://tts.baidu.com/audio.mp3')
    expect(plays[0].title).toBe('李存勖')
    expect(plays[0].source).toBe('tts')
    expect(plays[0].cover).toBe('https://bkimg.cdn.bcebos.com/smart/xxx')
    // 字幕：标题=词条名，内容=摘要切成歌词格式（多行、带 time，逐句高亮）
    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{ title: string; lines: Array<{ time: number; text: string }> }>
    expect(subs.length).toBe(1)
    expect(subs[0].title).toBe('李存勖')
    expect(subs[0].lines.length).toBeGreaterThan(0)
    expect(subs[0].lines.every((l) => typeof l.time === 'number' && l.text.length > 0)).toBe(true)
    expect(subs[0].lines.map((l) => l.text).join('')).toContain('五代后唐开国皇帝')
    expect(h.agentCalls()).toBe(0)
  })

  it('字幕与音频同源：只用实际播报的正文，不用完整 summary（否则字幕比语音快近一倍）', async () => {
    const spoken = '五代后唐开国皇帝，军事才能出众。他善于骑射，长于谋略。'
    const h = createHarness({
      finalizeText: '百科李存勖',
      baikeQuery: async () => ({
        entry: { title: '李存勖', summary: `${spoken}这段因超出播报字数被截断，从未念出来。` },
        text: `李存勖：${spoken}`,
        spoken,
      }),
      baikeAudioUrl: async () => 'https://tts.baidu.com/audio.mp3',
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{ lines: Array<{ time: number; text: string }> }>
    expect(subs.length).toBe(1)
    expect(subs[0].lines.map((l) => l.text).join('')).toBe(spoken)
  })

  it('百科音频接口失败：不播、不用网关文字转语音兜底（播不了就算了）', async () => {
    const h = createHarness({
      finalizeText: '百科李存勖',
      baikeQuery: async () => ({
        entry: { title: '李存勖', summary: '五代后唐开国皇帝。' },
        text: '李存勖：五代后唐开国皇帝。',
      }),
      baikeAudioUrl: async () => { throw new Error('getaudio failed') },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 音频失败：不播音频、不口播文字，只发 llm.done 收尾
    expect(h.events.some((e) => e.type === 'media.play')).toBe(false)
    expect(h.events.some((e) => e.type === 'media.subtitle')).toBe(false)
    expect(texts(h)).not.toContain('五代后唐开国皇帝')
    expect(h.events.some((e) => e.type === 'llm.done')).toBe(true)
    expect(h.agentCalls()).toBe(0)
  })

  it('「讲讲XX的事迹」：也能命中百科直连', async () => {
    let queried = ''
    const h = createHarness({
      finalizeText: '讲讲李存勖的事迹',
      baikeQuerySpy: (q) => { queried = q },
      baikeQuery: async () => ({ entry: null, text: '李存勖：一生征战，后唐开国。' }),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(queried).toBe('李存勖')
    expect(texts(h)).toContain('后唐开国')
    expect(h.agentCalls()).toBe(0)
  })

  it('纯「百科」无话题：提示用户说查谁，不联网查询', async () => {
    let called = false
    const h = createHarness({
      finalizeText: '百科',
      baikeQuery: async () => { called = true; return { entry: null, text: '' } },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(called).toBe(false)
    expect(texts(h)).toContain('想查谁的百科')
    expect(h.agentCalls()).toBe(0)
  })
})

describe('诗词朗读直连（背诵/朗诵，绕开 LLM）', () => {
  function texts(h: Harness): string {
    return h.events
      .filter((e): e is Extract<ServerEvent, { type: 'llm.delta' }> => e.type === 'llm.delta')
      .map((e) => e.text)
      .join('')
  }

  it('「朗诵岳阳楼记」：查到→字幕逐句原文 + 百度朗读音频，助手框只播确认', async () => {
    let queried = ''
    const h = createHarness({
      finalizeText: '朗诵岳阳楼记',
      poemQuery: async (t) => {
        queried = t
        return {
          title: '岳阳楼记', author: '范仲淹', dynasty: '宋', sid: 'abc',
          lines: ['庆历四年春，', '滕子京谪守巴陵郡。'],
          audioUrl: 'https://hanyu-poem-mp3.cdn.bcebos.com/abc.mp3',
        }
      },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    expect(queried).toBe('岳阳楼记')
    expect(texts(h)).toContain('正在为你朗读')
    expect(texts(h)).not.toContain('庆历四年春')
    const plays = h.events.filter((e) => e.type === 'media.play') as Array<{ url: string; source?: string }>
    expect(plays.length).toBe(1)
    expect(plays[0].url).toBe('https://hanyu-poem-mp3.cdn.bcebos.com/abc.mp3')
    expect(plays[0].source).toBe('tts')
    const subs = h.events.filter((e) => e.type === 'media.subtitle') as Array<{ title: string; lines: Array<{ text: string }> }>
    expect(subs.length).toBe(1)
    expect(subs[0].title).toBe('岳阳楼记')
    expect(subs[0].lines.map((l) => l.text)).toEqual(['庆历四年春，', '滕子京谪守巴陵郡。'])
    expect(h.agentCalls()).toBe(0)
  })

  it('「背诵回乡偶书，给我回答没有书的好价」：作品名截断到回乡偶书，查不到诚实提示、不被好价抢走', async () => {
    let queried = ''
    let dealsCalled = false
    const h = createHarness({
      finalizeText: '背诵回乡偶书，给我回答没有书的好价',
      poemQuery: async (t) => { queried = t; return null },
      dealsQuery: async () => { dealsCalled = true; return { deals: [], text: '' } },
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    // 作品名在标点处截断，不带后面的「给我回答没有书的好价」
    expect(queried).toBe('回乡偶书')
    // 查不到时诚实提示，不交给 LLM、也不被好价分支抢走
    expect(texts(h)).toContain('暂时没找到')
    expect(texts(h)).not.toContain('好价')
    expect(dealsCalled).toBe(false)
    expect(h.agentCalls()).toBe(0)
  })
})


describe('VAD 幻觉二级判断（短语音 + 无有效意图 → 丢弃）', () => {
  const judge = (text: string, vd: number, selection = false): boolean =>
    (createHarness().service as unknown as {
      isHallucinationShort: (t: string, v: number, sel: boolean) => boolean
    }).isHallucinationShort(text, vd, selection)

  it('长语音一律放行（真人正常说话）', () => {
    expect(judge('嗯', 1.5)).toBe(false)
    expect(judge('我', 1.5)).toBe(false)
    expect(judge('随便聊聊天', 3.0)).toBe(false)
  })

  it('VAD 无数据/上游 ASR（-1）跳过判断，行为不变', () => {
    expect(judge('我', -1)).toBe(false)
    expect(judge('8', -1)).toBe(false)
  })

  it('短语音 + 无语义幻觉单字 → 判幻觉（打嗝/吸鼻子/回声）', () => {
    expect(judge('我', 0.2)).toBe(true)
    expect(judge('你', 0.3)).toBe(true)
    expect(judge('8', 0.1)).toBe(true)   // 无选号上下文的单字数字=打嗝幻觉
    expect(judge('三', 0.3)).toBe(true)
    // 嗯哼/嗝 等拟声叠字由 isNoise 的 COUGH_FILLER_CHARS 拦，走不到二级判断
  })

  it('短语音但命中有效意图 → 放行（不误杀真人指令）', () => {
    expect(judge('停', 0.3)).toBe(false)   // 实义单字
    expect(judge('好', 0.2)).toBe(false)
    expect(judge('9', 0.2, true)).toBe(false)  // 数字选号（有候选列表上下文）
    expect(judge('下一首', 0.4)).toBe(false)
    expect(judge('播放音乐', 0.4)).toBe(false)
    expect(judge('第二首', 0.4)).toBe(false) // 选号，多字
  })

  it('多字句一律放行（哪怕 VAD 判很短）', () => {
    expect(judge('我要听歌', 0.2)).toBe(false)
    expect(judge('今天天气', 0.3)).toBe(false)
  })
})

describe('skill 接入：生命周期钩子经 voiceSessionService 调用', () => {
  it('定稿时调用 skill.onFinalize，LLM 收尾调用 onAgentReply，播完调用 onAfterSpeak', async () => {
    const calls: string[] = []
    const spySkill = {
      id: 'spy',
      name: 'spy',
      description: () => '',
      create: () => ({
        async onFinalize() { calls.push('finalize'); return { consumed: false } },
        onAgentReply() { calls.push('agentReply'); return { appendTts: '要记下来吗？' } },
        async onAfterSpeak() { calls.push('afterSpeak') },
        onSessionReset() { calls.push('reset') },
      }),
    }
    const h = createHarness({ skillModules: [spySkill] })
    await startDialog(h.service)
    await speakUtterance(h)
    // 等整个 turn（含 agent 回复 + 同链追问 + 播完钩子）跑完
    await sleep(300)
    h.finishReply()
    h.playbackDone()
    await sleep(100)

    expect(calls).toContain('finalize')
    expect(calls).toContain('agentReply')
    expect(calls).toContain('afterSpeak')
    // 同链追问文本被拼进 llm.delta 下发
    expect(h.events.some((e) => e.type === 'llm.delta' && String((e as { text?: string }).text ?? '').includes('记'))).toBe(true)
  })
})
