import type { SUPPORTED_LANGUAGES } from '../config/constants'

// 文案 key 只在这些语言下维护，和全局 language 选项保持一致
export type Locale = (typeof SUPPORTED_LANGUAGES)[number]
