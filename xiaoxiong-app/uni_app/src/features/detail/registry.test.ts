import { describe, expect, it, vi } from 'vitest'
import type { MediaDetail } from '@/core/transport/types'
import { resolveDetailMeta } from './registry'

/**
 * 内容类型分派表：容器只按 kind 查表，不写死任何类型。
 * 测试锁定「列表视图无操作栏」「选中后操作栏齐全」「未知 kind 中性兜底」，
 * 这三条是新增内容类型时不会改容器与状态结构的前提。
 */

type DetailEvent = Extract<MediaDetail, { type: 'media.detail' }>

function makeDetail(patch: Partial<DetailEvent> = {}): DetailEvent {
  return {
    type: 'media.detail',
    kind: 'deals',
    items: [
      {
        index: 1,
        title: '全棉时代婴儿棉柔巾',
        image: 'https://img.xxx/a.jpg',
        link: 'https://www.smzdm.com/p/1/',
        fields: [{ label: '现价', value: '200元' }],
      },
      // 第二个刻意缺 image / link / fields：换源少了字段也不能崩
      { index: 2, title: '无链接商品' },
    ],
    ...patch,
  }
}

describe('detail registry', () => {
  it('列表视图（未选号）不显示操作栏', () => {
    const meta = resolveDetailMeta('deals')
    expect(meta.actions(makeDetail(), vi.fn())).toEqual([])
    expect(meta.title(makeDetail())).toBeTruthy()
  })

  it('选中某件后操作栏齐全：复制链接 + 收藏/分享/邮箱占位', () => {
    // 复制链接的可用性取决于平台能力，这里补一个可用的 uni 让断言聚焦在操作栏结构上
    vi.stubGlobal('uni', { setClipboardData: vi.fn(), showToast: vi.fn() })
    const meta = resolveDetailMeta('deals')
    const actions = meta.actions(makeDetail({ selectedIndex: 1 }), vi.fn())

    expect(actions.map((a) => a.key)).toEqual(['copyLink', 'favorite', 'share', 'email'])
    expect(actions.every((a) => a.label.length > 0)).toBe(true)
    // 有 link 时复制可用
    expect(actions[0].disabled).toBe(false)
    vi.unstubAllGlobals()
  })

  it('选中项缺 link 时复制不装死：点击如实提示暂无链接，不碰剪贴板', async () => {
    const setClipboardData = vi.fn()
    vi.stubGlobal('uni', { setClipboardData, showToast: vi.fn() })
    const notify = vi.fn()
    const meta = resolveDetailMeta('deals')
    const [copy] = meta.actions(makeDetail({ selectedIndex: 2 }), notify)

    expect(copy.key).toBe('copyLink')
    await copy.run()

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBeTruthy()
    expect(setClipboardData).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('开源项目（project）复用同一套标题/操作栏，不另起一套交互', () => {
    const project = makeDetail({
      kind: 'project',
      items: [{ index: 1, title: 'UIEIP', link: 'https://x/uieip', fields: [{ label: '语言', value: 'Go' }] }],
    })
    const meta = resolveDetailMeta('project')
    expect(meta.title(project)).toBeTruthy()
    // 列表形态无操作栏；选中后与商品一致：复制链接 + 收藏/分享/邮箱
    expect(meta.actions(project, vi.fn())).toEqual([])
    const actions = meta.actions({ ...project, selectedIndex: 1 }, vi.fn())
    expect(actions.map((a) => a.key)).toEqual(['copyLink', 'favorite', 'share', 'email'])
  })

  it('未知 kind 走中性兜底：有标题、无操作、不抛错', () => {
    const meta = resolveDetailMeta('chart')
    expect(meta.title(makeDetail())).toBeTruthy()
    expect(meta.actions(makeDetail(), vi.fn())).toEqual([])
  })
})
