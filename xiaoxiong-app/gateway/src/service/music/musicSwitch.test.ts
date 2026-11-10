import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from '../voiceSessionService'
import type { VoiceSessionDeps } from '../voiceSessionService'
import type { AgentService } from '../agentService'
import type { AsrProvider } from '../../asr'
import type { TtsProvider } from '../../tts'
import type { DataService } from '../dataService'
import type { MusicSource } from './types'
import type { ResolvedCapabilities } from '../../voiceConfig'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Harness {
  service: VoiceSessionService
  /** 每次会话 start 时传给 agentFactory 的 musicSource，用来验证始终可用 */
  captured: Array<MusicSource | undefined>
}

function createHarness(): Harness {
  const captured: Array<MusicSource | undefined> = []
  const agent: AgentService = { reply: async () => '' }
  const asr: AsrProvider = {
    async push() {
      return null
    },
    async finalize() {
      return ''
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
  const deps: VoiceSessionDeps = {
    agentFactory: (_lang, _tz, _loc, _locProvider, musicSource) => {
      captured.push(musicSource)
      return agent
    },
    createAsr: () => asr,
    createTts: () => tts,
    resolveVoice: () => ({}) as unknown as ResolvedCapabilities,
    data,
    send: () => {},
    sendAudio: () => {},
    asrEndpointMs: 10,
  }
  return { service: new VoiceSessionService(deps), captured }
}

async function startSession(service: VoiceSessionService): Promise<void> {
  service.handleText(
    JSON.stringify({ type: 'session.start', sessionId: 's', lang: 'zh-CN', mode: 'dialog' })
  )
  await sleep(5)
}

describe('音乐播放源（无配置、始终可用）', () => {
  it('每次会话都构造音乐源，音乐工具始终注册', async () => {
    const h = createHarness()
    await startSession(h.service)
    expect(h.captured[0]).toBeTruthy()
  })

  it('风格请求走 SomaFM（离线可验证）', async () => {
    const h = createHarness()
    await startSession(h.service)
    const track = await h.captured[0]!.resolve('放点爵士')
    expect(track.url).toContain('somafm.com')
  })

  it('换一首在不传风格时返回与当前不同的 SomaFM 频道', async () => {
    const h = createHarness()
    await startSession(h.service)
    const source = h.captured[0]!
    const first = await source.resolve('放点爵士')
    const second = await source.next!('放点爵士')
    expect(second.channel).not.toBe(first.channel)
  })
})

