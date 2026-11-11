import { describe, it, expect } from 'vitest'
import {
  FLOAT_BASE_Z_INDEX,
  registerFloatLayer,
  unregisterFloatLayer,
} from './floatLayer'

describe('通用悬浮层：层级注册', () => {
  it('同 id 重复注册返回同一层级，不随组件重渲染一直涨', () => {
    const a = registerFloatLayer('unit-same')
    expect(registerFloatLayer('unit-same')).toBe(a)
    expect(a).toBeGreaterThanOrEqual(FLOAT_BASE_Z_INDEX)
    unregisterFloatLayer('unit-same')
  })

  it('不同业务各占不同层级，且都压在页面内容之上', () => {
    const a = registerFloatLayer('unit-a')
    const b = registerFloatLayer('unit-b')
    expect(a).toBeGreaterThanOrEqual(FLOAT_BASE_Z_INDEX)
    expect(b).toBeGreaterThanOrEqual(FLOAT_BASE_Z_INDEX)
    expect(b).not.toBe(a)
    unregisterFloatLayer('unit-a')
    unregisterFloatLayer('unit-b')
  })

  it('业务卸载释放层级后，同 id 重新注册仍可用', () => {
    const a = registerFloatLayer('unit-release')
    unregisterFloatLayer('unit-release')
    const b = registerFloatLayer('unit-release')
    expect(b).toBeGreaterThanOrEqual(FLOAT_BASE_Z_INDEX)
    unregisterFloatLayer('unit-release')
  })
})
