import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpVoiceAsr } from './http'

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
