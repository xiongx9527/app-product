/**
 * 前后端参数加解密（前端侧）。与网关 `gateway/src/crypto.ts` 完全一致的信封格式：
 * RSA-2048 OAEP(SHA-1) 加密 AES-256-GCM 会话密钥，业务数据用该会话密钥做 AES-GCM。
 *
 * 密钥模型：前后端各持一对 RSA 公私钥（共 2 对）。
 *  - 请求方向（前端 → 后端）：前端用「后端公钥」加密，后端用「后端私钥」解密。
 *  - 响应方向（后端 → 前端）：后端用「前端公钥」加密，前端用「前端私钥」解密。
 * 因此前端持有：前端私钥（解密响应）+ 后端公钥（加密请求）；后端持有相反两半。
 *
 * 浏览器 / 原生 WebView 走 Web Crypto（crypto.subtle）；Node / 测试环境走 Node 自带 webcrypto。
 * 地址与密钥均来自构建期环境变量（与后端 PORT 统一由 dev 脚本注入 / .env 配置），不写死。
 */

/** 是否启用前后端参数加密（与后端 PARAM_ENCRYPT 保持一致）。 */
export function isParamEncryptEnabled(): boolean {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = meta?.VITE_PARAM_ENCRYPT
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta === 'true'
  if (typeof process !== 'undefined') {
    const fromProc = process.env?.VITE_PARAM_ENCRYPT
    if (typeof fromProc === 'string' && fromProc.length > 0) return fromProc === 'true'
  }
  return false
}

/** 前端 RSA 私钥（PEM/PKCS8）：解密后端发来的响应。 */
export function getFrontendPrivateKey(): string | undefined {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = meta?.VITE_RSA_FRONTEND_PRIVATE_KEY?.trim()
  if (fromMeta) return fromMeta
  if (typeof process !== 'undefined') {
    const fromProc = process.env?.VITE_RSA_FRONTEND_PRIVATE_KEY?.trim()
    if (fromProc) return fromProc
  }
  return undefined
}

/** 后端 RSA 公钥（PEM/SPKI）：加密发往后端请求体。 */
export function getBackendPublicKey(): string | undefined {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = meta?.VITE_RSA_BACKEND_PUBLIC_KEY?.trim()
  if (fromMeta) return fromMeta
  if (typeof process !== 'undefined') {
    const fromProc = process.env?.VITE_RSA_BACKEND_PUBLIC_KEY?.trim()
    if (fromProc) return fromProc
  }
  return undefined
}

interface Envelope {
  /** RSA 加密后的会话密钥（base64） */
  k: string
  /** AES-GCM 初始向量（base64） */
  iv: string
  /** AES-GCM 认证标签（base64） */
  t: string
  /** AES-GCM 密文（不含 tag，base64） */
  d: string
}

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) throw new Error('当前环境不支持 Web Crypto（无法做参数加解密）')
  return c
}

function isFilled(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** PEM（SPKI/PKCS8）→ DER：去掉头尾与换行后 base64 解码。 */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return b64ToBytes(b64)
}

async function importPublicKey(publicPem: string): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    'spki',
    pemToDer(publicPem),
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['encrypt']
  )
}

async function importPrivateKey(privatePem: string): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    'pkcs8',
    pemToDer(privatePem),
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['decrypt']
  )
}

/** 用 RSA 公钥加密任意字符串（混合加密），返回与网关一致的 JSON 信封字符串。 */
export async function encryptWithPublicKey(publicPem: string, plaintext: string): Promise<string> {
  const crypto = getCrypto()
  const sessionKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey('raw', sessionKey, { name: 'AES-GCM' }, false, ['encrypt'])
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(enc)
  const tag = combined.slice(combined.length - 16)
  const ct = combined.slice(0, combined.length - 16)
  const publicKey = await importPublicKey(publicPem)
  const sealedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, sessionKey)
  )
  const env: Envelope = {
    k: bytesToB64(sealedKey),
    iv: bytesToB64(iv),
    t: bytesToB64(tag),
    d: bytesToB64(ct),
  }
  return JSON.stringify(env)
}

/** 用 RSA 私钥解密 JSON 信封字符串，返回原文。 */
export async function decryptWithPrivateKey(privatePem: string, payload: string): Promise<string> {
  const crypto = getCrypto()
  const env = JSON.parse(payload) as Envelope
  const privateKey = await importPrivateKey(privatePem)
  const sessionKey = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64ToBytes(env.k))
  )
  const ct = b64ToBytes(env.d)
  const tag = b64ToBytes(env.t)
  const iv = b64ToBytes(env.iv)
  const aesKey = await crypto.subtle.importKey('raw', sessionKey, { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = new Uint8Array(ct.length + tag.length)
  combined.set(ct, 0)
  combined.set(tag, ct.length)
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, combined)
  return new TextDecoder().decode(dec)
}
