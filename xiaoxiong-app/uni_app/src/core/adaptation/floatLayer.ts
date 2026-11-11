/**
 * 通用悬浮层能力：为任意业务（音乐播放器、设备卡片、实时状态…）提供
 * 「浮在页面内容之上」的层级分配与位置约定。
 *
 * 只管层级 / 位置 / 注册，不关心内容——内容由各业务用 `FloatLayer` 组件的 slot 填。
 * 遵守 core 约定：不依赖 features / pages / 任何具体业务，播放器只是其中一个使用方。
 */

/** 悬浮锚点：四角 + 顶部/底部居中；不同业务挂不同锚点即可避免互相遮挡 */
export type FloatCorner =
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

/** 悬浮显示位置参数：锚点 + 可选偏移。作为统一入参传给 FloatLayer，也可存进配置。 */
export interface FloatPosition {
  corner: FloatCorner
  offsetX?: number
  offsetY?: number
}

/**
 * 常用位置预设：业务 / 设置页用 key 引用，避免各处硬编码坐标。
 * 新增业务想放别处，直接给 FloatLayer 传自定义 FloatPosition 即可，不必改这里。
 */
export const FLOAT_POSITION_PRESETS = {
  'top-center': { corner: 'top-center' },
  'top-left': { corner: 'top-left' },
  'top-right': { corner: 'top-right' },
  'bottom-center': { corner: 'bottom-center' },
  'bottom-left': { corner: 'bottom-left' },
  'bottom-right': { corner: 'bottom-right' },
} satisfies Record<string, FloatPosition>

/** 可存进配置的位置 key */
export type FloatPositionKey = keyof typeof FLOAT_POSITION_PRESETS

/** 悬浮层基准 z-index：所有悬浮 widget 从这里递增，保证压在页面普通内容之上 */
export const FLOAT_BASE_Z_INDEX = 900

/** 角落默认内边距（px），避开屏幕边缘 / 安全区 */
export const FLOAT_INSET = 16

const layers = new Map<string, number>()

/**
 * 注册一个悬浮业务，返回它应使用的 z-index。
 * 相同 id 重复注册返回已分配值（组件重渲染不会让层级一直涨）；不同业务按注册顺序递增，
 * 各自占一层、互不遮挡。id 建议用业务标识（如 'music-disc' / 'device-panel'）。
 */
export function registerFloatLayer(id: string): number {
  const existing = layers.get(id)
  if (existing !== undefined) return existing
  const z = FLOAT_BASE_Z_INDEX + layers.size
  layers.set(id, z)
  return z
}

/** 业务卸载时释放层级名额；之后新注册的业务可复用该层级 */
export function unregisterFloatLayer(id: string): void {
  layers.delete(id)
}
