/**
 * 网关 /music/stream 代理地址构造：客户端 InnerAudioContext 无法自定义 Referer，
 * 防盗链直链（由网关在 media.play 用 `proxy` 标记）必须走网关代理。
 *
 * 频道 → 是否代理的判定已上移到网关（属「百度」源特有知识），客户端不再写死任何频道名，
 * 只按 media.play.proxy 标记决定是否拼这个代理前缀。
 */

/** 把裸直链改写为网关代理地址；没给基地址时原样返回，避免拼出坏 URL。 */
export function toProxiedMusicUrl(rawUrl: string, httpBase: string): string {
  if (!httpBase) return rawUrl
  return `${httpBase}/music/stream.m4a?url=${encodeURIComponent(rawUrl)}`
}
