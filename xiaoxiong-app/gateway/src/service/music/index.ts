import type { MusicFetcher, MusicSource } from './types'
import { createBaiduMusicSource } from './baidu'
import { createNeteaseMusicSource } from './netease'
import { createTencentMusicSource } from './tencent'
import { createKugouMusicSource } from './kugou'

export type { MusicSource }

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * 需要走网关 /music/stream 代理的频道：客户端 InnerAudioContext 无法自定义 Referer，
 * 而这些频道的直链带防盗链（需 Referer）必须由网关代拉再转发。
 * 本集合对应「百度」播放源内部会吐出的下游提供方（B 站 / 好看），属源特有知识，
 * 故判定留在网关侧，客户端只认 media.play 里的 `proxy` 标记，不再写死任何频道名。
 */
const PROXY_CHANNELS = new Set(['bilibili', 'haokan'])

/** 该频道音频是否需经网关代理；客户端据 media.play.proxy 决定是否改写播放地址。 */
export function needsProxy(channel?: string): boolean {
  return !!channel && PROXY_CHANNELS.has(channel)
}

/** 当前支持的播放源；缺省/未知值一律回退到百度（B 站音轨 + 百度搜索兜底）。 */
const VALID_SOURCES = ['baidu', 'netease', 'tencent', 'kugou'] as const
export type MusicSourceKind = (typeof VALID_SOURCES)[number]

function resolveSourceKind(source?: string): MusicSourceKind {
  return (VALID_SOURCES as readonly string[]).includes(source ?? '') ? (source as MusicSourceKind) : 'baidu'
}

/**
 * 按客户端设置页下发的播放源构造音乐源（session.start.playback.source）。
 * 百度已实现；网易云 / 腾讯音乐 / 酷狗音乐当前为占位空实现，调用会抛「未实现」。
 * 后续新增来源时在此按 source 分支调用对应 createXxxMusicSource 即可，
 * 各来源内部自行决定子源组合，互不影响。
 */
export function createMusicSource(
  opts?: { source?: string; fetcher?: MusicFetcher },
): MusicSource {
  const fetcher = opts?.fetcher ?? nativeFetch
  switch (resolveSourceKind(opts?.source)) {
    case 'baidu':
      return createBaiduMusicSource(fetcher)
    case 'netease':
      return createNeteaseMusicSource(fetcher)
    case 'tencent':
      return createTencentMusicSource(fetcher)
    case 'kugou':
      return createKugouMusicSource(fetcher)
  }
}
