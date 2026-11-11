import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from './voiceSessionService'
import { ChannelSplitter } from './channelSplitter'
import type { VoiceSessionDeps } from './voiceSessionService'
import type { AgentService } from './agentService'
import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { DataService } from './dataService'
import type { ResolvedCapabilities } from '../voiceConfig'
import type { ServerEvent } from '../protocol'
import type { HealthReport } from './health'
import type { MusicSource } from './music/types'
import type { DealsSnapshot } from './tools/dealsTool'
import type { Deal, DealDetail } from './deals'

/** 100ms 的方波人声帧（16k/16bit/mono），能量远高于自适应门限。 */
function loudFrame(samples = 1600): Uint8Array {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 2 === 0 ? 12000 : -12000
  return new Uint8Array(pcm.buffer)
}

function silentFrame(samples = 1600): Uint8Array {
  return new Uint8Array(samples * 2)
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
    musicSourceFactory?: () => MusicSource
    candidateFetcher?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    /** 句末静音定稿阈值（毫秒）；默认 10ms，贴近真实长停顿测试时调大 */
    asrEndpointMs?: number
    /** 预置记忆：全新会话 start 时由 getMemories 返回，用于验证系统提示注入 */
    memories?: Array<{ key: string; value: string; updatedAt: number }>
    /** 设备标识；传 null 可验证「无 deviceId 不注入记忆」。默认 test-device */
    deviceId?: string | null
    /** 懒加载定位超时（毫秒）；测试压短，默认 50ms */
    locationRequestTimeoutMs?: number
    /** 注入能力探测桩：返回各能力 reachable 与否；缺省「全部就绪」，不下发 client.cue */
    capabilityProbe?: () => Promise<HealthReport | null>
    /** 注入商品/好价查询桩（口播文本 + 结构化 Deal[]），避免直连用例真的联网抓页面 */
    dealsQuery?: () => Promise<DealsSnapshot>
    /** 注入详情页补充信息桩；缺省返回 null（不联网），需要验证合并时再注入 */
    dealsDetail?: (deal: Deal) => Promise<DealDetail | null>
    /** 智能体口播文本（经 ChannelSplitter 下发）；默认「好的，我来说一句。」。可注入泄漏标记验证兜底 */
    replyText?: string,
    /** 覆盖 resolveVoice：默认忽略 voice 返回空配置；需要验证「切来源重建 agent」时注入，
     *  按 voice.provider 返回不同的 llm 配置指纹，使重武装能识别来源变化。 */
    resolveVoice?: (voice?: unknown) => ResolvedCapabilities,
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
  }
  const asr: AsrProvider = {
    async push() {
      frames += 1
      return null
    },
    async finalize() {
      if (opts.finalizeTexts?.length) {
        const t = opts.finalizeTexts[Math.min(textIdx, opts.finalizeTexts.length - 1)]
        textIdx += 1
        return t
      }
      return opts.finalizeText ?? '今天天气怎么样'
    },
    reset() {},
  }
  const tts: TtsProvider = {
    async *synthesize() {
      for (const frame of ttsFrames) yield frame
    },
  }

  let service!: VoiceSessionService
  const forgetCalls: Array<{ deviceId: string | null; topic?: string }> = []
  let lastMemoryContext: string | undefined
  const data = {
    createSession: async () => 1,
    endSession: async () => {},
    insertCommandLog: () => {},
    saveMemory: async () => {},
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
    asrEndpointMs: opts.asrEndpointMs ?? 10,
    musicSourceFactory: opts.musicSourceFactory,
    candidateFetcher: opts.candidateFetcher,
    dealsQuery: opts.dealsQuery,
    // 默认不抓详情页：单测不联网；需要验证补充信息合并时由用例注入
    dealsDetail: opts.dealsDetail ?? (async () => null),
    locationRequestTimeoutMs: opts.locationRequestTimeoutMs ?? 50,
    deviceId: opts.deviceId === undefined ? 'test-device' : opts.deviceId,
    // 默认「全部就绪」，避免每个用例都下发 client.cue；需要验证不可用时由调用方注入 capabilityProbe
    capabilityProbe: opts.capabilityProbe,
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
    emitMedia: (m) => emitFn?.(m),
  }
}

async function startDialog(service: VoiceSessionService, lang = 'zh-CN'): Promise<void> {
  service.handleText(JSON.stringify({ type: 'session.start', sessionId: 's1', lang }))
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

  it('播放过程中不识别用户插话：播完之后才作为新一轮处理', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)

    // 播放过程中（未回执播完）再说的话：网关仍把识别结果回传（供客户端做
    // 唤醒词比对），但绝不识别成新轮次——不进队列、不触发新回答、不中途打断。
    await speakUtterance(h)
    await speakUtterance(h)
    await speakUtterance(h)
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(0)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
    expect(h.agentCalls()).toBe(1)

    // 客户端回执播完，本轮真正结束；之后再说才作为新一轮处理
    h.playbackDone()
    await sleep(30)
    h.finishReply()
    await sleep(20)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(2)
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

  it('tts.end 之后、playback_done 之前：回声（助手原话）被丢弃，不回传也不发起轮次', async () => {
    // 下发一帧高能量 TTS 音频，让门控拿到参考值；finalize 固定返回助手刚念过的原话，模拟回声
    const h = createHarness({ ttsFrames: [loudFrame()], finalizeText: '好的，我来说一句。' })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    // 此刻音频已下发完（speaking=false），但客户端还没回执播完。
    // 回声（与助手原话雷同）必须被丢弃，既不回传 asr.final，也不发起新轮次。
    const before = h.events.filter((e) => e.type === 'asr.final').length
    for (let i = 0; i < 8; i += 1) h.service.handleBinary(loudFrame())
    await sleep(40)
    expect(h.events.filter((e) => e.type === 'asr.final')).toHaveLength(before)
    expect(h.agentCalls()).toBe(1)
  })

  it('tts.end 之后、playback_done 之前：其它声音回传为 asr.final 但不发起新轮次', async () => {
    // 播报期间保留唤醒词识别：非回声的识别结果会回传给客户端做「小熊小熊」比对，
    // 但绝不发起新轮次、不进队列、不打断当前播报。
    const h = createHarness({ ttsFrames: [loudFrame()] })
    await startDialog(h.service)
    await speakUtterance(h)
    h.finishReply()
    await sleep(40)
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)

    const before = h.events.filter((e) => e.type === 'asr.final').length
    for (let i = 0; i < 8; i += 1) h.service.handleBinary(loudFrame())
    await sleep(40)
    expect(h.events.filter((e) => e.type === 'asr.final').length).toBeGreaterThan(before)
    expect(h.agentCalls()).toBe(1)
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(0)
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
      finalizeText: '查询商品',
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

  it('开源项目卡片：工具层下发列表后，说「第二个」切到该条详情、不进 LLM', async () => {
    const h = createHarness({ finalizeTexts: ['推荐点开源项目', '第二个'] })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    h.playbackDone()
    await sleep(20)

    const items = [
      { index: 1, title: 'UIEIP', link: 'https://x/uieip', fields: [{ label: '定位', value: '低代码平台' }] },
      { index: 2, title: 'vmr', link: 'https://x/vmr', fields: [{ label: '定位', value: 'SDK 版本管理' }] },
    ]
    // 工具层通过 emit 通道下发列表卡片（网关在此旁听并记住列表）
    h.emitMedia({ type: 'media.detail', kind: 'project', items })
    await sleep(20)
    expect(h.events.some((e) => e.type === 'media.detail' && e.kind === 'project')).toBe(true)

    const agentCallsBefore = h.agentCalls()
    await speakUtterance(h)
    await sleep(30)

    const selected = h.events.filter(
      (e): e is Extract<ServerEvent, { type: 'media.detail' }> =>
        e.type === 'media.detail' && e.selectedIndex !== undefined,
    )
    expect(selected).toHaveLength(1)
    expect(selected[0].kind).toBe('project')
    expect(selected[0].selectedIndex).toBe(2)
    expect(selected[0].items.map((i) => i.title)).toEqual(['UIEIP', 'vmr'])
    // 只口播一句确认，不复述简介；这句不进 LLM
    expect(texts(h)).toContain('第 2 个开源项目')
    expect(h.agentCalls()).toBe(agentCallsBefore)
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

  it('开源项目同样：含糊话后列表仍在，再说「第二个」能选中', async () => {
    const h = createHarness({ finalizeTexts: ['推荐点开源项目', '那个怎么样', '第二个'] })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(20)
    h.playbackDone()
    await sleep(20)

    h.emitMedia({
      type: 'media.detail',
      kind: 'project',
      items: [
        { index: 1, title: 'UIEIP', fields: [{ label: '定位', value: '低代码平台' }] },
        { index: 2, title: 'vmr', fields: [{ label: '定位', value: 'SDK 版本管理' }] },
      ],
    })
    await sleep(20)

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
    expect(selected[0].kind).toBe('project')
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

  it('开源项目：en-US 说越界编号 → 英文重问', async () => {
    const h = createHarness({ finalizeTexts: ['推荐点开源项目', '9'] })
    await startDialog(h.service, 'en-US')
    await speakUtterance(h)
    await sleep(20)
    h.playbackDone()
    await sleep(20)

    h.emitMedia({
      type: 'media.detail',
      kind: 'project',
      items: [
        { index: 1, title: 'UIEIP', fields: [{ label: 'Tagline', value: 'Low-code' }] },
        { index: 2, title: 'vmr', fields: [{ label: 'Tagline', value: 'SDK manager' }] },
      ],
    })
    await sleep(20)
    h.playbackDone()
    await sleep(20)
    const before = h.agentCalls()
    await speakUtterance(h)
    await sleep(30)

    expect(spoken(h)).toContain("Didn't catch which project")
    expect(spoken(h)).not.toContain('没听清是第几个')
    expect(h.agentCalls()).toBe(before)
  })
})
