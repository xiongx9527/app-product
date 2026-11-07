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

function uniRequest(opts: {
  url: string
  method: string
  data?: unknown
  header?: Record<string, string>
}): Promise<SecureResponse> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: opts.url,
      method: opts.method as UniApp.RequestOptions['method'],
      data: opts.data as UniApp.RequestOptions['data'],
      header: opts.header,
      success: (res) =>
        resolve({
          statusCode: res.statusCode,
          data: res.data,
          header: (res.header as Record<string, string>) ?? {},
        }),
      fail: (err) => reject(err),
    })
  })
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
