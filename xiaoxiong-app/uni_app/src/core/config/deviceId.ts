/**
 * 设备稳定标识：客户端首次运行时生成并持久化一个 UUID，之后所有连接复用同一标识。
 * 网关据此把会话与连接解耦——同一设备重连/重唤醒复用会话，保留对话记忆与待选歌单。
 *
 * 持久化只走本机存储（uni storage）；非 App 环境（浏览器/测试）回退到内存态，
 * 不影响逻辑正确性（测试场景下每次进程唯一的 id 也足够区分）。
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

/** 返回本机稳定 deviceId（首次生成并持久化，之后读取缓存）。 */
export function getDeviceId(): string {
  if (cached) return cached
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
