/**
 * 封面 URL 规范化：供歌曲宝 / B 站等各播放源共用，保证客户端 <image> 能加载。
 * - 清掉 JSON 转义残留的反斜杠（歌曲宝 appData 的 mp3_cover 形如 http:\/\/...，是非法 URL）
 * - 协议相对 // 补 https、http 明文升 https（原生 App / H5 混合内容会拦 http 图片）
 * 各源只管同源取出封面，统一经这里收敛后再随 media.play.cover 下发。
 */
export function normalizeCoverUrl(raw?: string): string | undefined {
  if (!raw) return undefined
  const u = raw.replace(/\\/g, '').trim()
  if (!u) return undefined
  if (u.startsWith('//')) return `https:${u}`
  if (u.startsWith('http://')) return `https://${u.slice('http://'.length)}`
  return u
}
