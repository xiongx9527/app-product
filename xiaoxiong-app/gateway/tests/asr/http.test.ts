import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpVoiceAsr } from '../../src/asr/http'

/** 一段短 PCM（16k/16bit）。小于 partial 最小字节，push 只入缓冲、不触发中间识别。 */
function pcmFrame(): Uint8Array {
  return new Uint8Array(2000)
}

/** 拦截 fetch，返回固定 text；把提交的 FormData 暴露给断言。 */
function stubFetch(captured: { form?: FormData }): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    captured.form = init.body as FormData
    return new Response(JSON.stringify({ text: '测试' }), { status: 200 })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpVoiceAsr：内置 ASR 必须显式下发 language', () => {
  it('未配置 language 时默认下发 zh，锁死中文解码（避免自动检测冒拼音碎片）', async () => {
    const captured: { form?: FormData } = {}
    stubFetch(captured)
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice')
    await asr.push(pcmFrame())
    await asr.finalize()
    expect(captured.form).toBeDefined()
    expect(captured.form!.get('language')).toBe('zh')
    expect(captured.form!.get('model')).toBe('sensevoice-small')
  })

  it('显式配置了 language 时尊重用户取值（不被 zh 覆盖）', async () => {
    const captured: { form?: FormData } = {}
    stubFetch(captured)
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice', { language: 'yue' })
    await asr.push(pcmFrame())
    await asr.finalize()
    expect(captured.form!.get('language')).toBe('yue')
  })

  it('language 为空字符串时同样回退到 zh', async () => {
    const captured: { form?: FormData } = {}
    stubFetch(captured)
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice', { language: '' })
    await asr.push(pcmFrame())
    await asr.finalize()
    expect(captured.form!.get('language')).toBe('zh')
  })
})

describe('HttpVoiceAsr：buffer 上限防爆（防长音频重复39遍）', () => {
  it('持续喂超长音频时 bufferedBytes 不超过 MAX_BUFFER_BYTES（丢弃最旧帧）', async () => {
    stubFetch({})
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice')
    const bigFrame = new Uint8Array(60000)
    // 喂 20 帧 = 1.2MB，远超 512000 上限
    for (let i = 0; i < 20; i += 1) await asr.push(bigFrame)
    const buffered = (asr as unknown as { bufferedBytes: number }).bufferedBytes
    expect(buffered).toBeLessThanOrEqual(512000)
    expect(buffered).toBeGreaterThan(0)
  })
})

describe('HttpVoiceAsr：定稿超时预算比中间识别宽', () => {
  it('partial 用 6s 快速失败，finalize 用 12s（慢上游不再定稿超时导致一个字都不出）', async () => {
    stubFetch({})
    // 拦截 AbortSignal.timeout 只记录预算、返回一个不会 abort 的信号，避免测试真的等超时
    const budgets: number[] = []
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(((ms: number) => {
      budgets.push(ms)
      return new AbortController().signal
    }) as typeof AbortSignal.timeout)
    try {
      const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice')
      // 20000 字节 ≥ PARTIAL_MIN_BYTES(12800)，push 会真的发一次中间识别
      await asr.push(new Uint8Array(20000))
      await asr.finalize()
      expect(budgets).toEqual([6000, 12000])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('HttpVoiceAsr：上游失败不能把占位文本当用户原话', () => {
  it('定稿时上游抛错 → finalize reject（由会话层走 asr-error 提示，而不是喂给大模型）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice')
    await asr.push(pcmFrame())
    await expect(asr.finalize()).rejects.toThrow(/asr unavailable/)
  })

  it('定稿时上游 500（返回非 JSON 错误页）同样 reject', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })))
    const asr = new HttpVoiceAsr('http://127.0.0.1:9529/voice')
    await asr.push(pcmFrame())
    await expect(asr.finalize()).rejects.toThrow(/asr unavailable/)
  })
})
