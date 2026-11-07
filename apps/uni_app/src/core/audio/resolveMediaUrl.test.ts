import { describe, it, expect } from 'vitest'
import { needMusicProxy, toProxiedMusicUrl } from './resolveMediaUrl'

describe('resolveMediaUrl（B 站音轨走网关代理）', () => {
  it('仅 bilibili/haokan 频道需要代理', () => {
    expect(needMusicProxy('bilibili')).toBe(true)
    expect(needMusicProxy('haokan')).toBe(true)
    expect(needMusicProxy('groovesalad')).toBe(false)
    expect(needMusicProxy(undefined)).toBe(false)
  })

  it('B 站直链改写为代理地址并 url-encode', () => {
    const raw = 'https://upos-sz-mirrorali.bilivideo.com/a.m4s?e=xy&x=1'
    const out = toProxiedMusicUrl(raw, 'bilibili', 'http://192.168.1.100:8787')
    expect(out).toBe(
      `http://192.168.1.100:8787/music/stream.m4a?url=${encodeURIComponent(raw)}`
    )
    expect(out).toContain('/music/stream.m4a?url=')
  })

  it('SomaFM 等公共流原样直连，不代理', () => {
    const raw = 'https://ice6.somafm.com/groovesalad-128-mp3'
    expect(toProxiedMusicUrl(raw, 'groovesalad', 'http://gateway')).toBe(raw)
    expect(toProxiedMusicUrl(raw, undefined, 'http://gateway')).toBe(raw)
  })

  it('没有网关基地址时原样返回（不拼出坏 URL）', () => {
    const raw = 'https://a.bilivideo.com/x.m4s'
    expect(toProxiedMusicUrl(raw, 'bilibili', '')).toBe(raw)
  })
})
