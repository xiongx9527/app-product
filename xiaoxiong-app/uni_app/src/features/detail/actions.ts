import type { MediaDetail } from '@/core/transport/types'
import { t } from '@/core/i18n'
import {
  createCopyLinkAction,
  createPlaceholderAction,
  type ActionNotify,
  type ShareAction,
} from '@/core/share/actions'

/**
 * 通用操作栏：所有内容类型（商品 / 开源项目 / 后续报表嵌入页）共用，容器只渲染数组。
 * 仅在选中单条详情时有意义（列表视图不显示操作栏）；复制链接真实，其余占位。
 * 只依赖协议层固定槽位 link，不认识任何业务字段——换 kind 不用改这里。
 */
export function detailActions(detail: MediaDetail, notify: ActionNotify): ShareAction[] {
  if (detail.selectedIndex == null) return []
  const item = detail.items.find((x) => x.index === detail.selectedIndex)
  // 没有 link 时不做「点了没反应」的死按钮：复用同一个 key/label，但改为如实提示暂无链接。
  const copy = item?.link
    ? createCopyLinkAction(t('detail.copyLink'), item.link, () => notify(t('detail.copied')))
    : createPlaceholderAction('copyLink', t('detail.copyLink'), () => notify(t('detail.noLink')))
  return [
    copy,
    // 收藏先只放按钮（与分享类同样走「暂未开放」），后续接本地收藏库时只换 run，容器与内容组件不动
    createPlaceholderAction('favorite', t('detail.favorite'), () =>
      notify(t('detail.notAvailable')),
    ),
    createPlaceholderAction('share', t('detail.share'), () =>
      notify(t('detail.notAvailable')),
    ),
    createPlaceholderAction('email', t('detail.email'), () =>
      notify(t('detail.notAvailable')),
    ),
  ]
}
