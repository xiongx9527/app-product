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
  /** 让当前这一轮的 reply 立刻 resolve */
  finishReply: () => void
  /** 模拟客户端播完回执 */
  playbackDone: () => void
  /** 被真正喂进 ASR 的帧数，用来验证回声门控 */
  asrFrames: () => number
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
  } = {}
): Harness {
  const ttsFrames = opts.ttsFrames ?? []
  const events: ServerEvent[] = []
  let calls = 0
  let frames = 0
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
  const data = {
    createSession: async () => 1,
    endSession: async () => {},
    insertCommandLog: () => {},
  } as unknown as DataService

  let service!: VoiceSessionService
  const deps: VoiceSessionDeps = {
    agentFactory: () => agent,
    asr,
    tts,
    data,
    send: (event) => events.push(event),
    sendAudio: () => {},
    asrEndpointMs: 10,
    musicSourceFactory: opts.musicSourceFactory,
    candidateFetcher: opts.candidateFetcher,
  }
  service = new VoiceSessionService(deps)
  return {
    service,
    events,
    agentCalls: () => calls,
    finishReply: () => finish?.(),
    playbackDone: () => service.handleText(JSON.stringify({ type: 'session.playback_done' })),
    asrFrames: () => frames,
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
