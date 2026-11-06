import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from './voiceSessionService'
import type { VoiceSessionDeps } from './voiceSessionService'
import type { AgentService } from './agentService'
import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { DataService } from './dataService'
import type { ServerEvent } from '../protocol'

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
}

function createHarness(): Harness {
  const events: ServerEvent[] = []
  let calls = 0
  let finish: (() => void) | null = null
  const agent: AgentService = {
    reply(_text, onDelta) {
      calls += 1
      onDelta('好的，我来说一句。')
      return new Promise<string>((resolve) => {
        finish = () => resolve('好的，我来说一句。')
      })
    },
  }
  const asr: AsrProvider = {
    async push() {
      return null
    },
    async finalize() {
      return '今天天气怎么样'
    },
    reset() {},
  }
  const tts: TtsProvider = {
    async *synthesize() {},
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
  }
  service = new VoiceSessionService(deps)
  return {
    service,
    events,
    agentCalls: () => calls,
    finishReply: () => finish?.(),
    playbackDone: () => service.handleText(JSON.stringify({ type: 'session.playback_done' })),
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

  it('当前轮没播完时用户插话：不打断，只识别并排队', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    expect(h.agentCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)

    // 第一轮还没结束，又说了三句
    await speakUtterance(h)
    await speakUtterance(h)
    await speakUtterance(h)
    const queued = h.events.filter((e) => e.type === 'asr.queued')
    expect(queued).toHaveLength(3)
    expect(h.events.some((e) => e.type === 'tts.stop')).toBe(false)
    expect(queued[2]).toMatchObject({ position: 3, size: 3 })

    // 第四句：队列满，拒收并说明原因
    await speakUtterance(h)
    const rejected = h.events.find((e) => e.type === 'asr.rejected')
    expect(rejected).toBeDefined()
    if (rejected?.type === 'asr.rejected') {
      expect(rejected.message).toContain('排队已满')
    }
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(3)

    // 当前轮播完（客户端回执）后才消费队首，且不会被中途插话另起一轮
    h.finishReply()
    await sleep(20)
    expect(h.agentCalls()).toBe(1)
    h.playbackDone()
    await sleep(30)
    expect(h.agentCalls()).toBe(2)
  })

  it('没有播完回执时，链不会提前开始下一句', async () => {
    const h = createHarness()
    await startDialog(h.service)
    await speakUtterance(h)
    await speakUtterance(h)
    expect(h.events.filter((e) => e.type === 'asr.queued')).toHaveLength(1)

    h.finishReply()
    await sleep(40)
    // 已发 tts.end，但客户端还没回执播完，不应启动第二轮
    expect(h.events.some((e) => e.type === 'tts.end')).toBe(true)
    expect(h.agentCalls()).toBe(1)
  })
})
