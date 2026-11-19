import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SKILL_MODULES, SKILL_MODULES_BY_PRIORITY, getSkillModule } from '../../../src/service/skills/registry'
import { loadSkillModules } from '../../../src/service/skills/loader'

const ORIGINAL_HOME = process.env.GATEWAY_HOME

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.GATEWAY_HOME
  else process.env.GATEWAY_HOME = ORIGINAL_HOME
  vi.restoreAllMocks()
})

describe('registry：内置 skill 显式清单', () => {
  it('preference 已登记且 id 唯一', () => {
    expect(getSkillModule('preference')?.id).toBe('preference')
    const ids = Object.values(SKILL_MODULES).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('未知 id 返回 undefined', () => {
    expect(getSkillModule('nope')).toBeUndefined()
  })
  it('按 priority 升序排列（skill 自声明顺序，不受登记顺序影响）', () => {
    const ps = SKILL_MODULES_BY_PRIORITY.map((m) => m.priority)
    expect([...ps].sort((a, b) => a - b)).toEqual(ps)
  })
  it('enabled 配置只作开关，返回顺序仍按 priority', () => {
    const home = resolve(tmpdir(), `skills-test-prio-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(resolve(home, 'skills.json'), JSON.stringify({ enabled: ['preference'] }))
    process.env.GATEWAY_HOME = home
    const mods = loadSkillModules()
    expect(mods.map((m) => m.id)).toEqual(['preference'])
    rmSync(home, { recursive: true, force: true })
  })
})

describe('loader：按 GATEWAY_HOME/skills.json 显式启用', () => {
  it('配置缺失 → 启用全部已登记 skill（保证现网行为不变）', () => {
    const home = resolve(tmpdir(), `skills-test-none-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    process.env.GATEWAY_HOME = home
    const mods = loadSkillModules()
    // 缺省全开，但顺序按 priority（不是登记顺序）
    expect(mods.map((m) => m.id)).toEqual(['auspicious', 'time', 'weather', 'preference'])
    rmSync(home, { recursive: true, force: true })
  })

  it('enabled 白名单 → 只启用列出的、按顺序', () => {
    const home = resolve(tmpdir(), `skills-test-list-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(resolve(home, 'skills.json'), JSON.stringify({ enabled: ['preference'] }))
    process.env.GATEWAY_HOME = home
    expect(loadSkillModules().map((m) => m.id)).toEqual(['preference'])
    rmSync(home, { recursive: true, force: true })
  })

  it('未知 id 跳过并 warn，不影响其它 skill', () => {
    const home = resolve(tmpdir(), `skills-test-unknown-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(resolve(home, 'skills.json'), JSON.stringify({ enabled: ['ghost', 'preference'] }))
    process.env.GATEWAY_HOME = home
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadSkillModules().map((m) => m.id)).toEqual(['preference'])
    expect(warn).toHaveBeenCalled()
    rmSync(home, { recursive: true, force: true })
  })

  it('enabled 为空数组 → 启用全部', () => {
    const home = resolve(tmpdir(), `skills-test-empty-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(resolve(home, 'skills.json'), JSON.stringify({ enabled: [] }))
    process.env.GATEWAY_HOME = home
    expect(loadSkillModules().length).toBe(Object.values(SKILL_MODULES).length)
    rmSync(home, { recursive: true, force: true })
  })
})
