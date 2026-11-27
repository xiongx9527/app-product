/**
 * 全局请求拦截器（2026-11-27）：一处给所有 uni.request 自动带上语音服务的 apiKey。
 *
 * 背景：访问网关数据接口（/api/mcp/tools、/api/skills 等）需要 x-voice-api-key
 * （VOICE_API_KEY_AUTH=on 时网关据此转发到上游）。此前每个 fetch 函数各自拼 header，
 * 新增接口容易漏。改成全局拦截器：App 启动注册一次，所有 uni.request 统一处理。
 *
 * - 配置就传、没配就不带（apiKey 为空时不加该头）。
 * - 不覆盖调用方显式传入的 x-voice-api-key（尊重特殊场景）。
 * - H5 无 uni 时静默跳过（H5 调试网关一般不鉴权）。
 */
import { appConfig } from '../config'

let installed = false

/** 在 App onLaunch 调用一次；重复调用幂等。 */
export function installRequestInterceptor(): void {
  if (installed) return
  installed = true
  if (typeof uni === 'undefined' || typeof uni.addInterceptor !== 'function') return

  uni.addInterceptor('request', {
    invoke(args: { header?: Record<string, string> | string }) {
      const key = appConfig.voice.builtin.apiKey
      if (!key) return
      // header 可能是字符串或对象；统一转成对象后写入，不覆盖已有的同名头
      const header = args.header
      if (typeof header === 'string') {
        args.header = { ...parseHeaderString(header), 'x-voice-api-key': key }
      } else if (header && typeof header === 'object') {
        if (!('x-voice-api-key' in header) && !('X-Voice-Api-Key' in header)) {
          args.header = { ...header, 'x-voice-api-key': key }
        }
      } else {
        args.header = { 'x-voice-api-key': key }
      }
    },
  })
}

/** 把字符串形式的 header（"k1: v1\nk2: v2"）转成对象，尽量保留原有内容。 */
function parseHeaderString(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
