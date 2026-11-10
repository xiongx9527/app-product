import { ref } from 'vue'

/**
 * 收藏列表（客户端内存态）。
 *
 * 业务语义与播放源无关：无论当前走百度还是其它来源，自然播放结束（含循环播完）的歌
 * 都进入同一个收藏列表，开关也是全局的、不按来源拆分。
 *
 * TODO(backend)：收藏的读写后端尚未实现（网关 SQLite + /api/admin/favorites）。
 * 目前用内存列表让「我的收藏」页面可见、可演示自动收藏流程；后续接 REST 时，
 * 这里改为按 deviceId 拉取/写入网关，并保留去重与移除语义。
 */
export interface FavoriteTrack {
  /** 歌曲标题（media.play 的 title） */
  title: string
  /** 播放地址（media.play 的 url）；作为去重主键 */
  url: string
  /** 加入收藏的时间戳（秒） */
  addedAt: number
}

const favorites = ref<FavoriteTrack[]>([])

export function addFavorite(track: { title: string; url: string }): void {
  const url = track.url?.trim()
  const title = track.title?.trim()
  if (!url || !title) return
  // 同 url 去重：已在收藏里就不再重复加入（重播同一首歌也不会堆积）。
  if (favorites.value.some((f) => f.url === url)) return
  favorites.value = [{ title, url, addedAt: Math.floor(Date.now() / 1000) }, ...favorites.value]
}

function removeFavorite(url: string): void {
  favorites.value = favorites.value.filter((f) => f.url !== url)
}

function hasFavorite(url: string): boolean {
  return favorites.value.some((f) => f.url === url)
}

export function useFavorites() {
  return { favorites, addFavorite, removeFavorite, hasFavorite }
}
