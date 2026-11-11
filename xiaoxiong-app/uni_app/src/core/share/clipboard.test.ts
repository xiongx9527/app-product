import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText, isClipboardSupported } from './clipboard'

/**
 * 剪贴板能力的回归测试。重点是「不弹任何浮层」：全项目零 uni.showToast，
 * 复制成功与否都只静默返回布尔值，行内提示由调用方负责。
 */

interface UniStub {
  setClipboardData: ReturnType<typeof vi.fn>
  showToast: ReturnType<typeof vi.fn>
}

function installUni(setClipboardData: UniStub['setClipboardData']): UniStub {
  const stub: UniStub = { setClipboardData, showToast: vi.fn() }
  vi.stubGlobal('uni', stub)
  return stub
}

describe('clipboard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('复制走 setClipboardData，且显式关闭系统 toast', async () => {
    const stub = installUni(
      vi.fn((opts: { data: string; showToast: boolean; success?: () => void }) => {
        opts.success?.()
      }),
    )

    await expect(copyText('https://example.com/p/1')).resolves.toBe(true)

    expect(stub.setClipboardData).toHaveBeenCalledTimes(1)
    const opts = stub.setClipboardData.mock.calls[0][0] as {
      data: string
      showToast: boolean
    }
    expect(opts.data).toBe('https://example.com/p/1')
    // 关键：必须关掉系统 toast，否则会冒出文字浮层
    expect(opts.showToast).toBe(false)
    expect(stub.showToast).not.toHaveBeenCalled()
  })

  it('复制失败静默返回 false，不抛异常也不弹 toast', async () => {
    const stub = installUni(
      vi.fn((opts: { fail?: () => void }) => {
        opts.fail?.()
      }),
    )

    await expect(copyText('x')).resolves.toBe(false)
    expect(stub.showToast).not.toHaveBeenCalled()
  })

  it('空文本不调用平台接口', async () => {
    const stub = installUni(vi.fn())

    await expect(copyText('')).resolves.toBe(false)
    expect(stub.setClipboardData).not.toHaveBeenCalled()
  })

  it('平台接口抛错时收敛成 false', async () => {
    installUni(
      vi.fn(() => {
        throw new Error('boom')
      }),
    )

    await expect(copyText('x')).resolves.toBe(false)
  })

  it('无 uni 环境（能力不支持）时安全降级', async () => {
    vi.stubGlobal('uni', undefined)

    expect(isClipboardSupported()).toBe(false)
    await expect(copyText('x')).resolves.toBe(false)
  })
})
