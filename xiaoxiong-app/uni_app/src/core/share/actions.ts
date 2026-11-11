import { copyText, isClipboardSupported } from './clipboard'

/**
 * 通用操作项（core，与业务无关）：容器只负责渲染这个数组，不写死任何项、不感知 kind。
 * 不同内容类型（商品详情 / 报表 / 嵌入页…）由业务按类注入不同的操作数组；
 * label 由业务经 i18n 注入，core 不硬编码中文。
 */
export interface ShareAction {
  key: string
  label: string
  icon?: string
  disabled?: boolean
  run: () => void | Promise<void>
}

/** 把一句提示交给调用方在页面行内展示（不弹 toast / 浮层）。 */
export type ActionNotify = (text: string) => void

/**
 * 复制链接（本轮唯一真实能力）。link 为空或环境不支持时禁用——字段缺失容忍，
 * 不会因换数据源少了 link 而崩。复制成功回调供界面显示行内「已复制」。
 */
export function createCopyLinkAction(
  label: string,
  link: string | undefined,
  onCopied: () => void,
): ShareAction {
  const ok = !!link && isClipboardSupported()
  return {
    key: 'copyLink',
    label,
    icon: '/static/icons/copy.svg',
    disabled: !ok,
    run: async () => {
      if (!ok || !link) return
      if (await copyText(link)) onCopied()
    },
  }
}

/**
 * 占位操作（分享 / 发朋友圈 / 发邮箱）：接口与真实操作完全一致，
 * 后续接真实能力只需替换 run，详情框容器与内容组件都不用改。
 * 点击回调由业务注入（显示「暂未开放」），core 不持文案、不碰 UI。
 */
export function createPlaceholderAction(
  key: string,
  label: string,
  onUnavailable: () => void,
  icon?: string,
): ShareAction {
  return { key, label, icon, run: onUnavailable }
}
