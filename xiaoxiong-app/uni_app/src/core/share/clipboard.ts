/**
 * 剪贴板通用能力（core，与业务无关）：任何需要复制的卡片 / 字幕 / 报表都可复用。
 * 不持任何业务文案（内容由调用方传），不感知内容类型 kind。
 *
 * 沿用项目约定：uni.setClipboardData 带 showToast:false，行内「已复制」提示由调用方负责，
 * 不弹任何文字浮层（全项目零 uni.showToast）。与 useAssistant.copySubtitle 同一套行为。
 */

/** 当前环境是否支持写剪贴板：先判能力再决定是否降级，不直接抛到 UI。 */
export function isClipboardSupported(): boolean {
  return typeof uni !== 'undefined' && typeof uni.setClipboardData === 'function'
}

/**
 * 复制纯文本，返回是否成功。失败（不支持 / 抛错 / 空文本）静默返回 false，
 * 不抛异常、不弹 toast，由调用方决定行内提示。
 */
export function copyText(text: string): Promise<boolean> {
  if (!text || !isClipboardSupported()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      uni.setClipboardData({
        data: text,
        showToast: false,
        success: () => resolve(true),
        fail: () => resolve(false),
      })
    } catch {
      resolve(false)
    }
  })
}
