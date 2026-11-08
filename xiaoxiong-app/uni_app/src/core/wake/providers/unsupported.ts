import type { WakeProvider } from '../types'

export function createUnsupportedProvider(
  name = '当前端不支持常听唤醒'
): WakeProvider {
  return {
    name,
    isSupported: () => false,
    start() {
      // 无原生插件的端（如 H5 开发阶段）无常听能力，界面用按住或点击说话
    },
    stop() {
      // 无实现
    },
  }
}
