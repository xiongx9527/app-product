import type { WakeProvider } from '../types'

export function createUnsupportedProvider(
  name = '当前端不支持常听唤醒'
): WakeProvider {
  return {
    name,
    isSupported: () => false,
    start() {
      // H5 / 小程序无持续监听能力，界面用按住或点击说话
    },
    stop() {
      // 无实现
    },
  }
}
