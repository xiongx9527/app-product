import { describe, it, expect } from 'vitest'
import { detectVolumeCommand, parseVolumePercent } from './volumeControl'

describe('parseVolumePercent（口语目标值 → 0–1）', () => {
  it('百分比数字', () => {
    expect(parseVolumePercent('音量30%')).toBe(0.3)
    expect(parseVolumePercent('调整到音量为 50 %')).toBe(0.5)
  })

  it('百分之 X', () => {
    expect(parseVolumePercent('音量百分之二十')).toBe(0.2)
  })

  it('裸数字（默认当作百分比）', () => {
    expect(parseVolumePercent('音量调到30')).toBe(0.3)
    expect(parseVolumePercent('音量 80')).toBe(0.8)
  })

  it('最大 / 最小 / 一半', () => {
    expect(parseVolumePercent('音量调到最大')).toBe(1)
    expect(parseVolumePercent('最小声')).toBe(0)
    expect(parseVolumePercent('音量一半')).toBe(0.5)
    expect(parseVolumePercent('调到适中')).toBe(0.5)
  })

  it('超出范围收敛到 0–1', () => {
    expect(parseVolumePercent('音量150%')).toBe(1)
    expect(parseVolumePercent('音量200')).toBe(1)
  })

  it('没有目标值 → null', () => {
    expect(parseVolumePercent('调大音量')).toBeNull()
    expect(parseVolumePercent('声音小一点')).toBeNull()
  })
})

describe('detectVolumeCommand（口语 → 动作）', () => {
  it('设为绝对值', () => {
    expect(detectVolumeCommand('音量30%')).toEqual({ kind: 'set', value: 0.3 })
    expect(detectVolumeCommand('调整音量为30%')).toEqual({ kind: 'set', value: 0.3 })
    expect(detectVolumeCommand('音量调整为到至30')).toEqual({ kind: 'set', value: 0.3 })
    expect(detectVolumeCommand('音量调到最大')).toEqual({ kind: 'set', value: 1 })
    expect(detectVolumeCommand('音量一半')).toEqual({ kind: 'set', value: 0.5 })
  })

  it('调大 / 增大（无具体值 → increase）', () => {
    expect(detectVolumeCommand('调大音量')).toEqual({ kind: 'increase' })
    expect(detectVolumeCommand('增大音量')).toEqual({ kind: 'increase' })
    expect(detectVolumeCommand('提高声音')).toEqual({ kind: 'increase' })
    expect(detectVolumeCommand('声音大一点')).toEqual({ kind: 'increase' })
    expect(detectVolumeCommand('再调大')).toEqual({ kind: 'increase' })
    expect(detectVolumeCommand('再增')).toEqual({ kind: 'increase' })
  })

  it('调小 / 减小（无具体值 → decrease）', () => {
    expect(detectVolumeCommand('调小音量')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('减小音量')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('降低声音')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('声音小一点')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('再调小')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('再减')).toEqual({ kind: 'decrease' })
  })

  it('「再减 / 再增」仍相对增减，不携带上下文（复用 increase/decrease）', () => {
    expect(detectVolumeCommand('再减')).toEqual({ kind: 'decrease' })
    expect(detectVolumeCommand('再增')).toEqual({ kind: 'increase' })
  })

  it('带目标的「调大」按绝对值理解（不是再 +10%）', () => {
    expect(detectVolumeCommand('调大音量到50%')).toEqual({ kind: 'set', value: 0.5 })
  })

  it('非音量指令 → null', () => {
    expect(detectVolumeCommand('你好')).toBeNull()
    expect(detectVolumeCommand('今天天气怎么样')).toBeNull()
    expect(detectVolumeCommand('声音真好听')).toBeNull()
    expect(detectVolumeCommand('')).toBeNull()
  })
})
