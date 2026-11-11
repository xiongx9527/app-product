/**
 * 拼接「歌手 + 歌名」检索词，对「歌手已出现在歌名里」的情况去重，
 * 避免「周杰伦 一路向北」被再次拼成「周杰伦 周杰伦 一路向北」而搜不到字幕。
 *
 * 直接指令路径里 track.title 已经是「歌手 歌名」（如「周杰伦 一路向北」），
 * 而调用方又单独带了 artist（"周杰伦"），此时只用 title；其余情况正常拼接。
 * 这样不论调用方怎么拆 artist/title，最终检索词都不会重复歌手。
 */
export function joinArtistTitle(artist: string, title: string): string {
  const a = (artist ?? '').trim()
  const t = (title ?? '').trim()
  if (!a || !t) return `${a}${t}`.trim()
  if (t.toLowerCase().includes(a.toLowerCase())) return t
  return `${a} ${t}`
}
