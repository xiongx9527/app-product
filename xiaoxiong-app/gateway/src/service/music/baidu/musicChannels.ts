/**
 * SomaFM 免费网络电台频道表（无需 Key、直接 mp3 流）。
 * 作为「播放音乐」的音频源：用户说“放点轻音乐/电子/爵士”时按标签选台。
 *
 * 频道 id 与流地址取自 SomaFM 官方 channels.json / *.pls（2026-11 核对）：
 * - 直链格式为 `https://ice6.somafm.com/<id>-128-mp3`，ice6 是官方 .pls 里的首选主机；
 * - 注意 SomaFM 的 Icecast 会拒绝非浏览器 User-Agent（返回 403），原生 App 播放器无法自定义 UA，
 *   故风格电台经网关 /music/stream 代理（网关带浏览器 UA 代拉）转发，客户端据此把 proxy 标为真。
 */

export interface SomaChannel {
  /** 频道标识，如 groovesalad */
  id: string
  /** 客户端展示的频道名（中/英） */
  title: { zh: string; en: string }
  /** 直接可播放的 mp3 流地址 */
  url: string
  /** 风格关键词（小写），用于把中文风格词映射到频道 */
  tags: string[]
}

/** 默认频道：轻电子/氛围，最百搭 */
export const DEFAULT_CHANNEL = 'groovesalad'

/** 常用频道，覆盖常见风格（id 均为 SomaFM 官方真实频道） */
export const SOMA_CHANNELS: SomaChannel[] = [
  {
    id: 'groovesalad',
    title: { zh: 'Groove Salad（轻电子/氛围）', en: 'Groove Salad (ambient/electronic)' },
    url: 'https://ice6.somafm.com/groovesalad-128-mp3',
    tags: ['轻', '电子', '氛围', '放松', 'ambient', 'electronic', 'chill', 'lofi', '纯音乐'],
  },
  {
    id: 'dronezone',
    title: { zh: 'Drone Zone（极简氛围）', en: 'Drone Zone (minimal ambient)' },
    url: 'https://ice6.somafm.com/dronezone-128-mp3',
    tags: ['极简', '氛围', 'ambient', 'drone', '睡眠', '冥想'],
  },
  {
    id: 'lush',
    title: { zh: 'Lush（柔和人声）', en: 'Lush (soft vocals)' },
    url: 'https://ice6.somafm.com/lush-128-mp3',
    tags: ['人声', '柔和', 'vocal', 'pop', '流行', '轻音乐'],
  },
  {
    id: 'indiepop',
    title: { zh: 'Indie Pop（独立流行）', en: 'Indie Pop' },
    url: 'https://ice6.somafm.com/indiepop-128-mp3',
    tags: ['独立', '流行', 'indie', 'pop', '摇滚', 'rock'],
  },
  {
    id: 'sonicuniverse',
    title: { zh: 'Sonic Universe（爵士）', en: 'Sonic Universe (jazz)' },
    url: 'https://ice6.somafm.com/sonicuniverse-128-mp3',
    tags: ['爵士', 'jazz', '蓝调', 'blues', '萨克斯'],
  },
  {
    id: '7soul',
    title: { zh: 'Seven Inch Soul（灵歌/节奏）', en: 'Seven Inch Soul (soul/R&B)' },
    url: 'https://ice6.somafm.com/7soul-128-mp3',
    tags: ['灵歌', '灵魂乐', '节奏', 'soul', 'rnb', 'r&b', '舞曲', 'dance', '老歌'],
  },
]

const CHANNEL_BY_ID: Record<string, SomaChannel> = Object.fromEntries(
  SOMA_CHANNELS.map((c) => [c.id, c])
)

/**
 * 按风格词选频道：命中任一频道的 tag 即返回该频道；未命中或为空时回退默认频道。
 * 简单子串匹配，足够覆盖“放点电子/爵士/轻音乐”这类口语。
 */
export function pickChannel(genre?: string): SomaChannel {
  const g = (genre ?? '').toLowerCase()
  if (g) {
    for (const channel of SOMA_CHANNELS) {
      if (channel.tags.some((tag) => g.includes(tag))) return channel
    }
  }
  return CHANNEL_BY_ID[DEFAULT_CHANNEL]
}
