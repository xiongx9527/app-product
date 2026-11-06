import { appConfig } from '@/core/config'
import { MESSAGES } from './messages'
import type { SUPPORTED_LANGUAGES } from '@/core/config/constants'

// 文案 key 只在这些语言下维护，和全局 language 选项保持一致
export type Locale = (typeof SUPPORTED_LANGUAGES)[number]

export { SUPPORTED_LANGUAGES } from '@/core/config/constants'
export { MESSAGES } from './messages'

function resolve(locale: string, key: string): string {
  const catalog = (MESSAGES as Record<string, Record<string, string>>)[locale] ?? MESSAGES['zh-CN']
  return catalog[key] ?? key
}

/**
 * 按当前全局语言取文案；模板里直接调用即可，语言切换会被 Vue 的渲染依赖自动追踪。
 * vars 支持 `{name}` 占位符替换（如数量、provider 名）。
 * 注意：用户识别出的语音原文（你说 / 助手回复）不是 UI 文案，不要走这里。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text = resolve(appConfig.language, key)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return text
}
