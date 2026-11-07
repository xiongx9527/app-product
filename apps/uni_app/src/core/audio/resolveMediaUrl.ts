/**
 * B 站音轨直链带防盗链（需 Referer），客户端 InnerAudioContext 无法自定义请求头，
 * 所以命中这些频道的 media.play 要改写成网关 /music/stream 代理地址。
 * 其余频道（SomaFM 等公共 mp3 流）直连播放，不经过代理。
 */

/** 直链带防盗链、必须走网关代理的频道。 */
const PROXY_CHANNELS = new Set(['bilibili', 'haokan'])

/** 该频道的播放地址是否需要经网关代理。 */
export function needMusicProxy(channel?: string): boolean {
  return !!channel && PROXY_CHANNELS.has(channel)
}

/** 把裸直链改写为网关代理地址；无需代理或没给基地址时原样返回。 */
export function toProxiedMusicUrl(
  rawUrl: string,
  channel: string | undefined,
  httpBase: string
): string {
  if (!needMusicProxy(channel) || !httpBase) return rawUrl
  return `${httpBase}/music/stream.m4a?url=${encodeURIComponent(rawUrl)}`
}
