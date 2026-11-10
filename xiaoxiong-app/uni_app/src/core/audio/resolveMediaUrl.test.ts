import { describe, it, expect } from 'vitest'
import { toProxiedMusicUrl } from './resolveMediaUrl'

describe('resolveMediaUrl（按 media.play.proxy 拼网关代理地址）', () => {
  it('裸直链改写为代理地址并 url-encode', () => {
    const raw = 'https://upos-sz-mirrorali.bilivideo.com/a.m4s?e=xy&x=1'
    const out = toProxiedMusicUrl(raw, 'http://192.168.1.100:8787')
    expect(out).toBe(
      `http://192.168.1.100:8787/music/stream.m4a?url=${encodeURIComponent(raw)}`
    )
    expect(out).toContain('/music/stream.m4a?url=')
  })

  it('没有网关基地址时原样返回（不拼出坏 URL）', () => {
    const raw = 'https://a.bilivideo.com/x.m4s'
    expect(toProxiedMusicUrl(raw, '')).toBe(raw)
  })

  it('公共流与防盗链流走同一构造逻辑：是否代理由调用方按 proxy 标记决定', () => {
    // 这里只验证「给 proxy 就拼代理地址」这一纯构造行为；频道→代理的判定在网关侧单测覆盖
    const raw = 'https://ice6.somafm.com/groovesalad-128-mp3'
    expect(toProxiedMusicUrl(raw, 'http://gateway')).toBe(
      `http://gateway/music/stream.m4a?url=${encodeURIComponent(raw)}`
    )
  })
})
