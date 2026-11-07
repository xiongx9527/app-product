import { describe, it, expect } from 'vitest'
import { VoiceSessionService } from '../voiceSessionService'
import type { VoiceSessionDeps } from '../voiceSessionService'
import type { AgentService } from '../agentService'
import type { AsrProvider } from '../../asr'
import type { TtsProvider } from '../../tts'
import type { DataService } from '../dataService'
import type { MusicSource } from './types'
import type { MusicInfo } from '../../protocol'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Harness {
  service: VoiceSessionService
  /** 每次会话 start 时传给 agentFactory 的 musicSource，用来验证切换 */
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
    agentFactory: (_lang, _tz, _loc, _geo, musicSource) => {
      captured.push(musicSource)
      return agent
    },
    asr,
    tts,
    data,
    send: () => {},
    sendAudio: () => {},
    asrEndpointMs: 10,
  }
  return { service: new VoiceSessionService(deps), captured }
}

async function startWith(service: VoiceSessionService, music?: MusicInfo): Promise<void> {
  service.handleText(
    JSON.stringify({ type: 'session.start', sessionId: 's', lang: 'zh-CN', mode: 'dialog', music })
  )
  await sleep(5)
}

describe('音乐播放源切换', () => {
  it('切换 provider 后，新会话用对应的播放源解析出不同地址', async () => {
    const h = createHarness()

    await startWith(h.service, { provider: 'soma', params: { station: 'sonicuniverse' } })
    const jazz = await h.captured[0]!.resolve()
    expect(jazz.channel).toBe('sonicuniverse')
    expect(jazz.url).toContain('sonicuniverse')

    await startWith(h.service, {
      provider: 'custom',
      params: { streamUrl: 'https://my.example/stream.mp3', title: '我的电台' },
    })
    const custom = await h.captured[1]!.resolve()
    expect(custom.url).toBe('https://my.example/stream.mp3')
    expect(custom.title).toBe('我的电台')

    // 切回 SomaFM 的另一个频道
    await startWith(h.service, { provider: 'soma', params: { station: 'lush' } })
    const lush = await h.captured[2]!.resolve()
    expect(lush.channel).toBe('lush')
    expect(lush.url).toContain('lush')
  })

  it('未上报 music 时不构造播放源（音乐工具不注册）', async () => {
    const h = createHarness()
    await startWith(h.service, undefined)
    expect(h.captured[0]).toBeUndefined()
  })

  it('未知 provider 回退为不构造播放源', async () => {
    const h = createHarness()
    await startWith(h.service, { provider: 'not-exist', params: {} })
    expect(h.captured[0]).toBeUndefined()
  })
})
