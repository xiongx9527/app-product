import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
// 前端实现（Web Crypto）：信封格式必须与网关的 Node 实现完全一致
import { encryptWithPublicKey as feEncrypt, decryptWithPrivateKey as feDecrypt } from './secureParams'
// 网关实现（Node crypto）：仅用于证明前后端可互通，不在前端打包内
import { encryptWithPublicKey as gwEncrypt, decryptWithPrivateKey as gwDecrypt } from '../../../../gateway/src/crypto'

function genPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

const payload = JSON.stringify({ id: 42, name: '测试设备', list: [1, 2, 3] })

describe('前后端 RSA+AES 信封格式一致（cross-compat）', () => {
  it('前端加密 → 网关后端私钥解密（请求方向，前端用「后端公钥」加密）', async () => {
    const backend = genPair()
    const env = await feEncrypt(backend.publicKey, payload)
    // 网关侧用后端私钥解密，得到原文
    expect(gwDecrypt(backend.privateKey, env)).toBe(payload)
  })

  it('网关加密 → 前端私钥解密（响应方向，后端用「前端公钥」加密）', async () => {
    const frontend = genPair()
    const env = gwEncrypt(frontend.publicKey, payload)
    // 前端侧用前端私钥解密，得到原文
    expect(await feDecrypt(frontend.privateKey, env)).toBe(payload)
  })

  it('前端自环：加密后解密还原，且含 k/iv/t/d 四个 base64 字段', async () => {
    const frontend = genPair()
    const env = await feEncrypt(frontend.publicKey, payload)
    const parsed = JSON.parse(env)
    expect(typeof parsed.k).toBe('string')
    expect(typeof parsed.iv).toBe('string')
    expect(typeof parsed.t).toBe('string')
    expect(typeof parsed.d).toBe('string')
    expect(await feDecrypt(frontend.privateKey, env)).toBe(payload)
  })
})
