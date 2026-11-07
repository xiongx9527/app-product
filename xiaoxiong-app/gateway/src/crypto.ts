import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { constants } from 'node:crypto'

/**
 * 前后端参数加解密（非对称 + 混合加密）。
 *
 * 密钥模型：前后端各持有一对 RSA 公私钥，共 2 对。
 *  - 请求方向（前端 → 后端）：前端用「后端公钥」加密，后端用「后端私钥」解密。
 *  - 响应方向（后端 → 前端）：后端用「前端公钥」加密，前端用「前端私钥」解密。
 * 因此网关侧只需持有：后端私钥（解密请求）+ 前端公钥（加密响应）；
 * 前端侧持有：前端私钥（解密响应）+ 后端公钥（加密请求）。
 *
 * RSA 本身只能加密小块数据，故采用混合加密：随机生成 AES-256-GCM 会话密钥加密业务
 * 数据，再用 RSA 公钥加密该会话密钥，整体封装为 JSON 信封。
 */

export interface RsaKeyPair {
  publicKey: string // PEM (SPKI)
  privateKey: string // PEM (PKCS8)
}

/** 生成一对 RSA-2048 密钥（前端、后端各生成一对）。 */
export function generateRsaKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKey, privateKey }
}

/** 密文信封：RSA 加密后的会话密钥 + AES-GCM 的 iv/tag/密文，均为 base64。 */
interface Envelope {
  k: string
  iv: string
  t: string
  d: string
}

function rsaSeal(pubPem: string, data: Buffer): Buffer {
  const key: KeyObject = createPublicKey(pubPem)
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING }, data)
}

function rsaOpen(privPem: string, data: Buffer): Buffer {
  const key: KeyObject = createPrivateKey(privPem)
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING }, data)
}

/** 用 RSA 公钥加密任意字符串（混合加密），返回 JSON 信封字符串。 */
export function encryptWithPublicKey(publicPem: string, plaintext: string): string {
  const sessionKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const env: Envelope = {
    k: rsaSeal(publicPem, sessionKey).toString('base64'),
    iv: iv.toString('base64'),
    t: tag.toString('base64'),
    d: enc.toString('base64'),
  }
  return JSON.stringify(env)
}

/** 用 RSA 私钥解密 JSON 信封字符串，返回原文。 */
export function decryptWithPrivateKey(privatePem: string, payload: string): string {
  const env = JSON.parse(payload) as Envelope
  const sessionKey = rsaOpen(privatePem, Buffer.from(env.k, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.t, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.d, 'base64')), decipher.final()]).toString('utf8')
}
