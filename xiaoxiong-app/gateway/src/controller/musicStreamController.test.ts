import { describe, it, expect } from 'vitest'
import { isAllowedUpstreamUrl } from './musicStreamController'

describe('isAllowedUpstreamUrl（代理白名单 / 防 SSRF）', () => {
  it('放行 B 站 CDN 域名及其子域', () => {
    expect(isAllowedUpstreamUrl('https://upos-sz-mirrorali.bilivideo.com/upgcxcode/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('https://xy.mcdn.bilivideo.cn/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('https://a.b.akamaized.net/x.m4s')).toBe(true)
    expect(isAllowedUpstreamUrl('http://i0.hdslb.com/x.m4s')).toBe(true)
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
