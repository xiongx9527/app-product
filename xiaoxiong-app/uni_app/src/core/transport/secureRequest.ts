import {
  isParamEncryptEnabled,
  getBackendPublicKey,
  getFrontendPrivateKey,
  encryptWithPublicKey,
  decryptWithPrivateKey,
} from '@/core/crypto/secureParams'

/** REST 请求参数（与 uni.request 对齐的子集）。 */
export interface SecureRequestOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: unknown
  header?: Record<string, string>
}

export interface SecureResponse {
  statusCode: number
  data: unknown
  header: Record<string, string>
}

/**
 * 网关 REST 调用的超时（毫秒）。网关与 App 同机（回环 127.0.0.1），正常应毫秒级返回；
 * 但若上游（如内置来源经 adb reverse 指向 Mac 9529）不可达，uni.request 默认不超时，
 * 会永久挂起导致 settings 四个下拉 forever disabled（length 0、无错误提示）。
 * 这里统一兜底超时，让请求失败而非挂死，从而走 catch 分支给出可用状态/提示。
 */
const REQUEST_TIMEOUT_MS = 10_000

function uniRequest(opts: {
  url: string
  method: string
  data?: unknown
  header?: Record<string, string>
}): Promise<SecureResponse> {
  const network = new Promise<SecureResponse>((resolve, reject) => {
    uni.request({
      url: opts.url,
      method: opts.method as UniApp.RequestOptions['method'],
      data: opts.data as UniApp.RequestOptions['data'],
      header: opts.header,
      timeout: REQUEST_TIMEOUT_MS,
      success: (res) =>
        resolve({
          statusCode: res.statusCode,
          data: res.data,
          header: (res.header as Record<string, string>) ?? {},
        }),
      fail: (err) => reject(err),
    })
  })
  // 双保险：部分 uni-app 运行时的 uni.request 不认 timeout 选项而永久挂起，
  // 这里用 Promise.race + 手动计时兜底，确保超时 reject，绝不让请求卡死。
  const guard = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`secureRequest 超时(${REQUEST_TIMEOUT_MS}ms): ${opts.method} ${opts.url}`)),
      REQUEST_TIMEOUT_MS,
    ),
  )
  return Promise.race([network, guard])
}

/**
 * 与网关 REST（/api/*）通信的封装：当 PARAM_ENCRYPT 开启时，自动加密请求体、
 * 解密响应体（RSA+AES 信封）；关闭时退化为普通请求。前端当前未主动调用 /api/*，
 * 但加解密层已就绪，任何 REST 调用直接走这里即可端到端可用。
 */
export async function secureRequest(options: SecureRequestOptions): Promise<SecureResponse> {
  const enabled = isParamEncryptEnabled()
  const method = options.method ?? 'GET'
  const header = { ...options.header }
  let data = options.data

  if (enabled) {
    const backendPub = getBackendPublicKey()
    if (backendPub && (method === 'POST' || method === 'PUT')) {
      const plaintext = typeof data === 'string' ? data : JSON.stringify(data ?? null)
      data = await encryptWithPublicKey(backendPub, plaintext)
      header['Content-Type'] = 'application/json'
    }
    const frontendPriv = getFrontendPrivateKey()
    const res = await uniRequest({ url: options.url, method, data, header })
    if (frontendPriv && res.data && typeof res.data === 'object') {
      const wrapped = res.data as { encrypted?: boolean; data?: unknown }
      if (wrapped.encrypted === true && typeof wrapped.data === 'string') {
        const plain = await decryptWithPrivateKey(frontendPriv, wrapped.data)
        res.data = JSON.parse(plain)
      }
    }
    return res
  }

  return uniRequest({ url: options.url, method, data, header })
}
