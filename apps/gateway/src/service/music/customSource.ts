import { paramString, type MusicSource } from './types'

/**
 * 自定义电台：用户直接填一个可播放的音频流地址（自建电台、网络收音机、歌单直链等）。
 * 完全不固定来源，播什么由用户填的 URL 决定；风格词忽略。
 */
export function createCustomSource(
  params: Record<string, string | number | boolean> = {}
): MusicSource {
  const url = paramString(params, 'streamUrl')
  const title = paramString(params, 'title') || url || '自定义电台'
  return {
    resolve() {
      return { url, title, channel: 'custom' }
    },
  }
}
