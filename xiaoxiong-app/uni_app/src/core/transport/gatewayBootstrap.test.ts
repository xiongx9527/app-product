import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isEmbeddedGateway,
  getGatewayWsUrl,
  readEmbeddedGatewayUrl,
  waitForEmbeddedGateway,
} from './gatewayBootstrap'

/**
 * 用最小化的假 plus.io 驱动 gatewayBootstrap：仅覆盖本模块用到的
 * requestFileSystem / getFile / FileReader 链路，按 root 类型决定是否命中 gateway.url。
 */
function buildPlus(opts: {
  /** 读到的文件内容；传 null 表示读文件失败（onerror）。 */
  fileContents: string | null
  /** 各 root 类型（PRIVATE_DOC=1 …）是否存在 gateway.url；缺省全部存在。 */
  perRoot?: Record<number, boolean>
  /** 完全不给 plus.io（仅 { }），模拟 io 缺失。 */
  ioMissing?: boolean
  /** requestFileSystem 直接失败。 */
  fsFail?: boolean
}): unknown {
  const FileReader = class {
    onloadend: (() => void) | null = null
    onerror: (() => void) | null = null
    result: string | ArrayBuffer | null = null
    readAsText() {
      if (opts.fileContents === null) {
        queueMicrotask(() => this.onerror?.())
      } else {
        this.result = opts.fileContents
        queueMicrotask(() => this.onloadend?.())
      }
    }
  }
  const io = {
    PRIVATE_DOC: 1,
    APPLICATION: 2,
    PRIVATE_WWW: 3,
    PUBLIC_DOCUMENTS: 4,
    File_Reader_unused: null,
    FileReader,
    requestFileSystem: (
      type: number,
      success: (fs: { root: unknown }) => void,
      fail?: () => void,
    ) => {
      if (opts.fsFail) {
        fail?.()
        return
      }
      const exists =
        opts.perRoot && type in opts.perRoot ? opts.perRoot[type] : true
      success({
        root: {
          getFile: (
            _path: string,
            _options: { create: boolean },
            entrySuccess: (entry: { file: (ok: (f: unknown) => void) => void }) => void,
            entryFail?: () => void,
          ) => {
            if (!exists) {
              entryFail?.()
              return
            }
            entrySuccess({
              file: (fileSuccess) => {
                const reader = new FileReader()
                fileSuccess({})
                // 真实运行时 reader.readAsText(file) 会异步触发 onloadend；
                // 这里由模块内部调用，下面无需再调。
              },
            })
          },
        },
      })
    },
  }
  return opts.ioMissing ? {} : { io }
}

describe('isEmbeddedGateway', () => {
  afterEach(() => {
    delete (globalThis as unknown as { plus?: unknown }).plus
  })

  it('非 APP-PLUS 环境（无 plus）返回 false', () => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    expect(isEmbeddedGateway()).toBe(false)
  })

  it('APP-PLUS 环境（有 plus）返回 true', () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:1234/ws',
    })
    expect(isEmbeddedGateway()).toBe(true)
  })
})

describe('getGatewayWsUrl 回退（无可用地址时）', () => {
  afterEach(() => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    vi.unstubAllEnvs()
  })

  it('无 plus：回退默认地址', async () => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:8787/ws')
  })

  it('有 plus 但 io 缺失：回退默认地址', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      ioMissing: true,
      fileContents: 'ws://127.0.0.1:1234/ws',
    })
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:8787/ws')
  })

  it('requestFileSystem 失败：回退默认地址', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fsFail: true,
      fileContents: 'ws://127.0.0.1:1234/ws',
    })
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:8787/ws')
  })

  it('所有 root 都读不到 gateway.url：回退默认地址', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: null,
      perRoot: { 1: false, 2: false, 3: false, 4: false },
    })
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:8787/ws')
  })
})

describe('getGatewayWsUrl 命中 gateway.url', () => {
  afterEach(() => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    vi.unstubAllEnvs()
  })

  it('命中 PRIVATE_DOC：返回文件内容（含动态端口）', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:4321/ws',
    })
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:4321/ws')
  })

  it('第一个 root 缺失、第二个命中：返回第二个内容', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:9999/ws',
      // roots 顺序 PRIVATE_DOC(1) → APPLICATION(2) → PRIVATE_WWW(3) → PUBLIC_DOCUMENTS(4)
      perRoot: { 1: false, 2: true, 3: true, 4: true },
    })
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:9999/ws')
  })

  it('文件存在但内容为空：视为未命中，回退默认', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: '',
    })
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:8787/ws')
  })

  it('plus 存在且文件有内容时优先于 VITE_GATEWAY_WS_URL', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:5678/ws',
    })
    vi.stubEnv('VITE_GATEWAY_WS_URL', 'ws://10.0.0.1:8787/ws')
    expect(await getGatewayWsUrl()).toBe('ws://127.0.0.1:5678/ws')
  })
})

describe('readEmbeddedGatewayUrl（不回退，供就绪轮询）', () => {
  afterEach(() => {
    delete (globalThis as unknown as { plus?: unknown }).plus
  })

  it('非 APP-PLUS：直接返回 null（交给回退逻辑）', async () => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    expect(await readEmbeddedGatewayUrl()).toBeNull()
  })

  it('有 plus 且命中 gateway.url：返回文件内容', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:4321/ws',
    })
    expect(await readEmbeddedGatewayUrl()).toBe('ws://127.0.0.1:4321/ws')
  })

  it('所有 root 都读不到：返回 null（不回退默认地址）', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: null,
      perRoot: { 1: false, 2: false, 3: false, 4: false },
    })
    expect(await readEmbeddedGatewayUrl()).toBeNull()
  })
})

describe('waitForEmbeddedGateway（enable 前等待就绪）', () => {
  afterEach(() => {
    delete (globalThis as unknown as { plus?: unknown }).plus
  })

  it('非内嵌环境：立即返回 true（就绪由真实建连判断）', async () => {
    delete (globalThis as unknown as { plus?: unknown }).plus
    expect(await waitForEmbeddedGateway({ timeoutMs: 50, pollMs: 10 })).toBe(true)
  })

  it('内嵌且 gateway.url 已存在：立即返回 true', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: 'ws://127.0.0.1:4321/ws',
    })
    expect(await waitForEmbeddedGateway({ timeoutMs: 200, pollMs: 10 })).toBe(true)
  })

  it('内嵌但始终读不到 gateway.url：超时返回 false（不静默）', async () => {
    ;(globalThis as unknown as { plus?: unknown }).plus = buildPlus({
      fileContents: null,
      perRoot: { 1: false, 2: false, 3: false, 4: false },
    })
    const start = Date.now()
    const ready = await waitForEmbeddedGateway({ timeoutMs: 60, pollMs: 10 })
    expect(ready).toBe(false)
    // 等了至少一个轮询周期，证明它真的在轮询而非立即返回
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})
