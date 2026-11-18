/**
 * 设备稳定标识：优先用原生系统级标识（Android ANDROID_ID，卸载重装不变），
 * 拿不到则回退到「客户端生成 UUID 存 uni storage」（旧方案，卸载重装会变）。
 * 网关据此把会话与连接解耦——同一设备重连/重唤醒复用会话，保留对话记忆与待选歌单。
 *
 * 为什么要原生标识：uni storage 在卸载 App 时被清空，自生成 UUID 会变、旧记忆/配置成孤儿。
 * Android 的 ANDROID_ID 存在系统 Settings.Secure，签名不变时卸载重装不变、无需权限。
 * iOS 待做（方案：Keychain 存 UUID，卸载重装保留）。
 * 非 App 环境（浏览器/测试）无原生插件，回退到内存态。
 */

const STORAGE_KEY = 'app-product.deviceId'

let cached: string | null = null

function generateId(): string {
  // 优先用环境自带的 UUID；没有则退回到基于随机数的实现
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 原生稳定标识（Android ANDROID_ID）。插件 app-product-wake 的 getStableDeviceId()
 * 是 @UniJSMethod 同步返回 String；拿不到（iOS / 旧基座 / 非 App）返回空串。
 * 必须在返回 storage UUID 之前尝试，且只认非空字符串。
 */
function nativeStableId(): string {
  if (typeof uni === 'undefined') return ''
  const scope = uni as unknown as { requireNativePlugin?: (name: string) => unknown }
  if (typeof scope.requireNativePlugin !== 'function') return ''
  try {
    const plugin = scope.requireNativePlugin('app-product-wake') as { getStableDeviceId?: () => string } | null
    const id = plugin?.getStableDeviceId?.()
    return typeof id === 'string' && id ? id : ''
  } catch {
    return ''
  }
}

/** 返回本机稳定 deviceId（原生系统标识优先，回退 UUID 存 storage）。 */
export function getDeviceId(): string {
  if (cached) return cached
  // ① 原生系统级标识：卸载重装不变（Android）。拿到后覆盖旧 UUID，让老用户升级即切换。
  const native = nativeStableId()
  if (native) {
    cached = native
    if (typeof uni !== 'undefined' && typeof uni.setStorageSync === 'function') {
      try { uni.setStorageSync(STORAGE_KEY, native) } catch { /* 不阻断 */ }
    }
    return native
  }
  // ② 回退：storage 里的旧 UUID（含老用户已持久化的），没有才新生成
  if (typeof uni !== 'undefined' && typeof uni.getStorageSync === 'function') {
    try {
      const stored = uni.getStorageSync(STORAGE_KEY)
      if (typeof stored === 'string' && stored) {
        cached = stored
        return cached
      }
    } catch {
      /* 读取失败按未持久化处理 */
    }
  }
  const id = generateId()
  cached = id
  if (typeof uni !== 'undefined' && typeof uni.setStorageSync === 'function') {
    try {
      uni.setStorageSync(STORAGE_KEY, id)
    } catch {
      /* 持久化失败不阻断，仅本进程内复用 */
    }
  }
  return id
}
