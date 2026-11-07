import { describe, it, expect } from 'vitest'
import { isAllowedUpstreamUrl, inferAudioContentType } from './musicStreamController'

describe('isAllowedUpstreamUrl（代理白名单 / 防 SSRF）', () => {
  it('放行 B 站 CDN 域名及其子域', () => {
    expect(isAllowedUpstreamUrl('https://upos-sz-mirrorali.bilivideo.com/upgcxcode/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('https://xy.mcdn.bilivideo.cn/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('https://a.b.akamaized.net/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('http://i0.hdslb.com/x.m4s')).toBe(true)
    // 新版 mcdn 边缘节点域名（「周杰伦的歌」实际落在 mountaintoys.cn，曾因不在白名单被代理 400 拒绝）
    expect(isAllowedUpstreamUrl('https://nqyu06l.edge.mountaintoys.cn:4483/upgcxcode/x.m4s?e=xxx')).toBe(true)
    expect(isAllowedUpstreamUrl('https://xy.mcdn.biliapi.com/x.m4s')).toBe(true)
  })

  it('拒绝非白名单域名（含伪造后缀、内网、本机）', () => {
    expect(isAllowedUpstreamUrl('https://bilivideo.com.evil.com/x.m4s')).toBe(false)
    expect(isAllowedUpstreamUrl('https://evilbilivideo.com/x.m4s')).toBe(false)
    expect(isAllowedUpstreamUrl('http://127.0.0.1:8787/api/health')).toBe(false)
    expect(isAllowedUpstreamUrl('http://192.168.1.1/')).toBe(false)
    expect(isAllowedUpstreamUrl('https://example.com/a.mp3')).toBe(false)
  })

  it('拒绝非 http(s) 协议与非法 URL', () => {
    expect(isAllowedUpstreamUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedUpstreamUrl('ftp://a.bilivideo.com/x')).toBe(false)
    expect(isAllowedUpstreamUrl('not a url')).toBe(false)
    expect(isAllowedUpstreamUrl('')).toBe(false)
  })
})

describe('inferAudioContentType（B 站 m4s 等需显式标 MIME）', () => {
  it('B 站 dash 音频片段按扩展名标成 audio/mp4', () => {
    expect(
      inferAudioContentType('https://upos-sz.bilivideo.com/x/31475957784-1-30232.m4s?e=xxx')
    ).toBe('audio/mp4')
    expect(inferAudioContentType('https://i0.hdslb.com/x.m4a')).toBe('audio/mp4')
    expect(inferAudioContentType('https://i0.hdslb.com/x.mp4')).toBe('audio/mp4')
  })

  it('其余常见音频扩展名映射正确的 MIME', () => {
    expect(inferAudioContentType('https://a.bilivideo.com/x.mp3')).toBe('audio/mpeg')
    expect(inferAudioContentType('https://a.bilivideo.com/x.aac')).toBe('audio/aac')
    expect(inferAudioContentType('https://a.bilivideo.com/x.ogg')).toBe('audio/ogg')
  })

  it('无法识别时回落 audio/mpeg（与网关历史默认一致）', () => {
    expect(inferAudioContentType('https://a.bilivideo.com/x.bin')).toBe('audio/mpeg')
    expect(inferAudioContentType('not a url')).toBe('audio/mpeg')
  })
})
