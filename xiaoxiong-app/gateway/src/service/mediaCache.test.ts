import { describe, it, expect } from 'vitest'
import { cacheExternalAudio, handleMediaByKey, type MediaFetcher } from './mediaCache'
import type { IncomingMessage, ServerResponse } from 'node:http'

describe('mediaCache（外部音频本地短链）', () => {
  it('下载音频落盘返回短链，同 url 复用', async () => {
    process.env.GATEWAY_HOME = `/tmp/media-cache-test-${Date.now()}`
    const wav = Buffer.from('fake mp3 bytes for test')
    let calls = 0
    const fetcher: MediaFetcher = async () => {
      calls += 1
      return { ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) }
    }
    const p1 = await cacheExternalAudio('https://example.com/a.mp3', fetcher)
    const p2 = await cacheExternalAudio('https://example.com/a.mp3', fetcher)
    expect(p1).toMatch(/^\/media\/s\/[0-9a-f]{16}\.mp3$/)
    expect(p2).toBe(p1) // 复用
    expect(calls).toBe(1)
  })

  it('下载失败返回 null（调用方回退原始 url）', async () => {
    process.env.GATEWAY_HOME = `/tmp/media-cache-test-fail-${Date.now()}`
    const fetcher: MediaFetcher = async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
    expect(await cacheExternalAudio('https://example.com/bad.mp3', fetcher)).toBe(null)
  })

  it('短链 serve 支持 Range + CORS', async () => {
    process.env.GATEWAY_HOME = `/tmp/media-cache-test-serve-${Date.now()}`
    const wav = Buffer.from('0123456789')
    const fetcher: MediaFetcher = async () => ({ ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) })
    const path = (await cacheExternalAudio('https://example.com/serve.mp3', fetcher))!
    const key = path.match(/([0-9a-f]{16})\.mp3$/)![1]

    const captured: { status?: number; headers?: Record<string, string> } = {}
    const res = {
      writeHead: (status: number, h: Record<string, string>) => { captured.status = status; captured.headers = h },
      end: () => {},
      destroy: () => {},
    } as unknown as ServerResponse
    // 用 HEAD 避开 createReadStream.pipe（mock res 不是 writable stream），只验证响应头
    const req = { method: 'HEAD', headers: { range: 'bytes=0-4' } } as unknown as IncomingMessage
    // createReadStream 是异步 pipe，这里只验证响应头（status/headers）
    handleMediaByKey(req, res, key)
    expect(captured.status).toBe(206)
    expect(captured.headers?.['content-type']).toBe('audio/mpeg')
    expect(captured.headers?.['Access-Control-Allow-Origin']).toBe('*')
  })
})
