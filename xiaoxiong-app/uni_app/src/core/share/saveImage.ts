/**
 * 通用「下载图片并保存到相册」能力（core，与业务无关）。
 * 报表图表下载、商品大图保存等都可复用；不持任何业务文案，成功/失败由调用方提示。
 *
 * 平台差异与踩坑（2026-11-27）：
 * - iOS 写相册需要 Info.plist 的 NSPhotoLibraryAddUsageDescription（打包脚本已注入）；
 *   缺这条时 saveImageToPhotosAlbum 会 fail，日志记下 errMsg 便于区分。
 * - 【2026-11-27】曾给 downloadFile 指定 USER_DATA_PATH 下带 .png 的 filePath，
 *   真机出现「点击无任何反应」——iOS 上指定 filePath 后 success/fail 回调可能都不触发，
 *   Promise 永远 pending、界面没提示。改用默认临时路径，并加 8s 超时兜底保证一定有结果。
 * - 诊断日志 console.log（'[saveImage]' 前缀）长期保留，真机可经 Safari/CDP 远程调试看到，
 *   区分 download/status/empty/album/timeout 五个失败环节。
 */

export interface SaveImageResult {
  ok: boolean
  /** 失败环节：download（下载失败）/ status（非 200）/ empty（无文件）/ album（存相册失败，含权限）/ timeout（超时兜底） */
  stage?: 'download' | 'status' | 'empty' | 'album' | 'timeout'
  errMsg?: string
}

/** 下载图片并写入系统相册。url 必须是可访问的绝对地址（调用方用 resolveImageUrl 拼好）。 */
export function downloadAndSaveImage(url: string): Promise<SaveImageResult> {
  if (!url) return Promise.resolve({ ok: false, stage: 'download', errMsg: 'empty url' })

  return new Promise<SaveImageResult>((resolve) => {
    let settled = false
    const done = (r: SaveImageResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.log('[saveImage]', r.ok ? 'ok' : `fail stage=${r.stage} err=${r.errMsg ?? ''}`, url)
      resolve(r)
    }

    // 超时兜底：downloadFile 在 iOS 指定 filePath 或网络异常时可能不回调，8s 后强制返回，
    // 避免 Promise 永远 pending、用户「点击没反应」。
    const timer = setTimeout(() => done({ ok: false, stage: 'timeout' }), 8000)

    uni.downloadFile({
      url,
      success: (r) => {
        if (r.statusCode !== 200) return done({ ok: false, stage: 'status', errMsg: `HTTP ${r.statusCode}` })
        const fp = r.tempFilePath || (r as any).savedFilePath
        if (!fp) return done({ ok: false, stage: 'empty' })
        // #ifdef APP-PLUS
        uni.saveImageToPhotosAlbum({
          filePath: fp,
          success: () => done({ ok: true }),
          fail: (e) => done({ ok: false, stage: 'album', errMsg: String((e as any)?.errMsg ?? e) }),
        })
        // #endif
        // #ifndef APP-PLUS
        done({ ok: true }) // H5/小程序无相册写入，视为下载成功
        // #endif
      },
      fail: (e) => done({ ok: false, stage: 'download', errMsg: String((e as any)?.errMsg ?? e) }),
    })
  })
}
