import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_PCM_CONFIG,
  isAppCaptureSupported,
  startAppCapture,
  stopAppCapture,
} from './appCapture'
import { hasMicBeenGranted, micGranted } from './micEvidence'

interface PluginShape {
  startPcm?: (o: Record<string, number>) => void
  stopPcm?: () => void
  onPcmFrame?: (cb: (frame: unknown) => void) => void
  onPcmError?: (cb: (p: unknown) => void) => void
}

function setPlugin(value: unknown): void {
  ;(globalThis as unknown as { uni?: unknown }).uni =
    value === undefined ? undefined : { requireNativePlugin: () => value }
}

afterEach(() => {
  stopAppCapture()
  delete (globalThis as unknown as { uni?: unknown }).uni
  micGranted.value = false
})

describe('appCapture 能力探测与降级', () => {
  it('插件缺失 / 只支持唤醒（无 PCM 接口）→ isSupported=false，启动返回 false', () => {
    setPlugin(undefined)
    expect(isAppCaptureSupported()).toBe(false)
    expect(startAppCapture(() => {}, () => {})).toBe(false)

    // 旧基座：只有唤醒接口，没有 startPcm/onPcmFrame
    setPlugin({ start: () => {}, stop: () => {}, onWake: () => {}, onError: () => {} })
    expect(isAppCaptureSupported()).toBe(false)
    expect(startAppCapture(() => {}, () => {})).toBe(false)
  })

  it('插件实现 PCM 接口 → isSupported=true，按契约参数启动', () => {
    const startPcm = vi.fn()
    const stopPcm = vi.fn()
    setPlugin({ startPcm, stopPcm, onPcmFrame: vi.fn(), onPcmError: vi.fn() })
    expect(isAppCaptureSupported()).toBe(true)
    expect(startAppCapture(() => {}, () => {})).toBe(true)
    expect(startPcm).toHaveBeenCalledWith({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      frameMs: 32,
    })
    expect(APP_PCM_CONFIG.frameMs).toBe(32)
    stopAppCapture()
    expect(stopPcm).toHaveBeenCalledTimes(1)
  })

  it('启动失败（原生抛异常）→ 返回 false，不置采集态', () => {
    setPlugin({
      startPcm: () => {
        throw new Error('录音被占用')
      },
      stopPcm: vi.fn(),
      onPcmFrame: vi.fn(),
    })
    expect(startAppCapture(() => {}, () => {})).toBe(false)
  })
})

describe('appCapture PCM 帧透传', () => {
  it('onPcmFrame 的 ArrayBuffer 帧原样交给 onChunk', () => {
    const holder: { emit?: (frame: unknown) => void } = {}
    setPlugin({
      startPcm: vi.fn(),
      stopPcm: vi.fn(),
      onPcmFrame: (cb: (frame: unknown) => void) => {
        holder.emit = cb
      },
    })
    const chunks: ArrayBuffer[] = []
    expect(startAppCapture((pcm) => chunks.push(pcm), () => {})).toBe(true)
    const frame = new Uint8Array([1, 2, 3, 4]).buffer
    holder.emit?.(frame)
    expect(chunks).toHaveLength(1)
    expect(new Uint8Array(chunks[0])).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('类型化数组帧（含 byteOffset）也能正确转成 ArrayBuffer', () => {
    const holder: { emit?: (frame: unknown) => void } = {}
    setPlugin({
      startPcm: vi.fn(),
      stopPcm: vi.fn(),
      onPcmFrame: (cb: (frame: unknown) => void) => {
        holder.emit = cb
      },
    })
    const chunks: ArrayBuffer[] = []
    startAppCapture((pcm) => chunks.push(pcm), () => {})
    const backing = new Uint8Array([9, 8, 7, 6, 5])
    holder.emit?.(backing.subarray(1, 4)) // byteOffset=1, 长度 3
    expect(chunks).toHaveLength(1)
    expect(new Uint8Array(chunks[0])).toEqual(new Uint8Array([8, 7, 6]))
  })

  it('stop 后不再透传帧', () => {
    const holder: { emit?: (frame: unknown) => void } = {}
    setPlugin({
      startPcm: vi.fn(),
      stopPcm: vi.fn(),
      onPcmFrame: (cb: (frame: unknown) => void) => {
        holder.emit = cb
      },
    })
    const chunks: ArrayBuffer[] = []
    startAppCapture((pcm) => chunks.push(pcm), () => {})
    stopAppCapture()
    holder.emit?.(new Uint8Array([1, 2]).buffer)
    expect(chunks).toHaveLength(0)
  })

  it('原生 onPcmError 把错误信息交给 onError', () => {
    const holder: { emit?: (p: unknown) => void } = {}
    setPlugin({
      startPcm: vi.fn(),
      stopPcm: vi.fn(),
      onPcmFrame: vi.fn(),
      onPcmError: (cb: (p: unknown) => void) => {
        holder.emit = cb
      },
    })
    const errors: string[] = []
    startAppCapture(() => {}, (m) => errors.push(m))
    holder.emit?.({ message: '设备被占用' })
    holder.emit?.('字符串错误')
    expect(errors).toEqual(['设备被占用', '字符串错误'])
  })
})

describe('micEvidence 跨端共享的授权实证', () => {
  it('App 采集成功也会标记麦克风已授权', () => {
    setPlugin({ startPcm: vi.fn(), stopPcm: vi.fn(), onPcmFrame: vi.fn() })
    expect(hasMicBeenGranted()).toBe(false)
    startAppCapture(() => {}, () => {})
    expect(hasMicBeenGranted()).toBe(true)
  })
})
