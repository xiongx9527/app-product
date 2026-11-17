/**
 * 媒体播放的业务编排：把「先下载短链到本地、再播放」这件事收敛在业务层，
 * core/audio/musicPlayer 只保留纯播放器能力（起播/暂停/音量），不掺业务下载逻辑。
 *
 * DCloud AudioPlayer 对 HTTP 流不稳（-99 且不发请求），本地文件 100% 可靠；
 * B 站 dash 音轨、新闻播报都由网关下发短链，下载完成后统一交给 playMusic。
 */
import { playMusic, preloadMusic, musicState } from '@/core/audio/musicPlayer'

export interface DownloadedMediaOptions {
  /** 播放遍数 */
  loop?: number
  /** 下载慢的整轨（评书 9MB+）先亮播放条显示「正在准备」，避免界面空白 */
  preload?: boolean
  /** 下载失败时降级回的直播流地址；不传则显示失败态 */
  fallbackUrl?: string
}

/** 下载一段音频短链到本地后播放；下载细节在业务层内部消化，调用方只给地址和选项。 */
export function playDownloadedMedia(
  downloadUrl: string,
  title: string,
  opts?: DownloadedMediaOptions
): void {
  const playOpts = opts?.loop != null ? { loop: opts.loop } : undefined
  if (opts?.preload) preloadMusic(title)
  uni.downloadFile({
    url: downloadUrl,
    success: (r) => {
      if (r.statusCode === 200 && r.tempFilePath) {
        playMusic(r.tempFilePath, title, playOpts)
        return
      }
      // 下载返回非 200/无临时文件：有降级直播流就回退，否则显示失败态
      if (opts?.fallbackUrl) playMusic(opts.fallbackUrl, title, playOpts)
      else musicState.musicError.value = true
    },
    fail: () => {
      // 有降级直播流就回退（旧行为），否则不静默吞掉：显示失败态
      if (opts?.fallbackUrl) playMusic(opts.fallbackUrl, title, playOpts)
      else musicState.musicError.value = true
    },
  })
}
