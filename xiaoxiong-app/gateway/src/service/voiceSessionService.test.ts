import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from './voiceSessionService'
import type { VoiceSessionDeps } from './voiceSessionService'
import type { AgentService } from './agentService'
import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { DataService } from './dataService'
import type { ServerEvent } from '../protocol'
import type { MusicSource } from './music/types'

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
  } = {}
): Harness {
  const ttsFrames = opts.ttsFrames ?? []
  const events: ServerEvent[] = []
  let calls = 0
  let frames = 0
  let factoryCalls = 0
  let textIdx = 0
  let finish: (() => void) | null = null
  const agent: AgentService = {
    reply(_text, onDelta) {
      calls += 1
      if (opts.delayDelta) {
        // 思考阶段不下发 TTS：processing 已为 true、playbackPending 仍为 false，
        // 用来验证「未播放时用户插话进队列」这条生存下来的排队路径。
        let resolveReply!: (value: string) => void
        const pending = new Promise<string>((resolve) => {
          resolveReply = resolve
        })
        finish = () => {
          onDelta('好的，我来说一句。')
          resolveReply('好的，我来说一句。')
        }
        return pending
      }
      onDelta('好的，我来说一句。')
      return new Promise<string>((resolve) => {
        finish = () => resolve('好的，我来说一句。')
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
    agentFactory: (_lang, _tz, _loc, _rev, _music, _emit, _store, memoryContext) => {
      factoryCalls += 1
      lastMemoryContext = memoryContext
      return agent
    },
    asr,
    tts,
    data,
    send: (event) => events.push(event),
    sendAudio: () => {},
    asrEndpointMs: opts.asrEndpointMs ?? 10,
    musicSourceFactory: opts.musicSourceFactory,
    candidateFetcher: opts.candidateFetcher,
    deviceId: opts.deviceId === undefined ? 'test-device' : opts.deviceId,
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
  }
}

async function startDialog(service: VoiceSessionService): Promise<void> {
  service.handleText(JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN' }))
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

  it('暂停播放：下发 media.pause（不是 media.stop），不进 LLM', async () => {
    // 用户反馈：说「暂停播放」结果被关掉（误判成 stop）。这条端到端用例走真实
    // finalizeUtterance 路径（带音乐源），验证命中 pause 后下发 media.pause、
    // 绝不发 media.stop，且绕开大模型。
    const h = createHarness({
      finalizeText: '暂停播放',
      musicSourceFactory: () => playSource(async () => ({ url: 'https://bili/x.m4s', title: 'x', channel: 'bilibili' })),
    })
    await startDialog(h.service)
    await speakUtterance(h)
    await sleep(30)

    const pauses = h.events.filter((e) => e.type === 'media.pause')
    const stops = h.events.filter((e) => e.type === 'media.stop')
    expect(pauses).toHaveLength(1)
    expect(stops).toHaveLength(0)
    // 直连绕开 LLM：不应调用 agent
    expect(h.agentCalls()).toBe(0)
    expect(texts(h)).toContain('已暂停')
  })

  /** 桩源：把每次播放/换歌时收到的关键词编码进标题，便于断言“换一首”是否沿用当前上下文。 */
  function contextSource(): MusicSource {
    let last = ''
    return {
      resolve: async (g) => {
        last = g ?? ''
        return { url: 'u', title: `R:${last}`, channel: 'bilibili' }
      },
      next: async (g) => {
        const k = g === undefined ? last : g
        last = k
        return { url: 'u', title: `N:${k}`, channel: 'bilibili' }
      },
    }
  }

  it('换一首：没指定新偏好时沿用当前上下文（同歌手），不跳到无关电台', async () => {
    // 用户反馈：播放周杰伦时说“换一首”，结果换了一首和当前无关的歌。
    // 根因：原逻辑把“换一首”收敛成 genre=轻音乐，被路由到 SomaFM 电台（与周杰伦无关）。
    // 修复：bare 换一首传 undefined，让音乐源沿用当前 B 站上下文 → 同歌手下一首。
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

    h.playbackDone()
    await sleep(20)
    await speakUtterance(h)
    await sleep(20)

    const plays2 = h.events.filter((e) => e.type === 'media.play')
    expect(plays2).toHaveLength(2)
    expect((plays2[1] as { title: string }).title).toContain('周杰伦') // 仍是周杰伦（同歌手下一首）
    expect((plays2[1] as { title: string }).title).not.toContain('轻音乐')
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

  it('候选检索为空：回退到直接解析（不卡住、不报错）', async () => {
    const h = createHarness({
      finalizeText: '周杰伦',
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

