import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCopyLinkAction, createPlaceholderAction } from './actions'

/**
 * 通用操作项：复制链接是唯一真实能力，分享类为占位。
 * 测试锁定「字段缺失容忍」与「占位项不静默」两条约定。
 */

function installUni(ok = true) {
  const setClipboardData = vi.fn((opts: { success?: () => void; fail?: () => void }) => {
    ok ? opts.success?.() : opts.fail?.()
  })
  vi.stubGlobal('uni', { setClipboardData, showToast: vi.fn() })
  return { setClipboardData }
}

describe('share actions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('复制链接：有 link 且环境支持时可用，成功后回调通知', async () => {
    const { setClipboardData } = installUni(true)
    const onCopied = vi.fn()
    const action = createCopyLinkAction('复制链接', 'https://example.com/p/1', onCopied)

    expect(action.key).toBe('copyLink')
    expect(action.disabled).toBe(false)

    await action.run()

    expect(setClipboardData).toHaveBeenCalledTimes(1)
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('复制链接：复制失败不误报「已复制」', async () => {
    installUni(false)
    const onCopied = vi.fn()
    const action = createCopyLinkAction('复制链接', 'https://example.com/p/1', onCopied)

    await action.run()

    expect(onCopied).not.toHaveBeenCalled()
  })

  it('复制链接：没有 link 时禁用，且点击无副作用', async () => {
    const { setClipboardData } = installUni(true)
    const onCopied = vi.fn()
    const action = createCopyLinkAction('复制链接', undefined, onCopied)

    expect(action.disabled).toBe(true)
    await action.run()

    expect(setClipboardData).not.toHaveBeenCalled()
    expect(onCopied).not.toHaveBeenCalled()
  })

  it('占位操作：点击走注入的「暂未开放」回调，不静默', () => {
    const onUnavailable = vi.fn()
    const action = createPlaceholderAction('share', '分享', onUnavailable, '/static/icons/share.svg')

    expect(action.key).toBe('share')
    expect(action.disabled).toBeFalsy()
    action.run()

    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })
})
