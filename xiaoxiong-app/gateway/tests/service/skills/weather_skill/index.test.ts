import { describe, it, expect } from 'vitest'
import type { SkillContext } from '../../../../src/service/skills/types'
import {
  detectWeatherCommand,
  extractWeatherCity,
  createWeatherSkill,
} from '../../../../src/service/skills/weather_skill/index'

describe('weather skill：意图识别（原 control/weatherControl.ts）', () => {
  it.each(['今天天气怎么样', '北京天气', '多少度', '会不会下雨'])('命中：%s', (text) => {
    expect(detectWeatherCommand(text)).toBe(true)
  })
  it.each(['', '   ', '播放周杰伦的稻香'])('不命中：%s', (text) => {
    expect(detectWeatherCommand(text)).toBe(false)
  })
})

describe('weather skill：城市提取', () => {
  it.each([
    ['北京天气怎么样', '北京'],
    ['查一下上海天气', '上海'],
    ['广州多少度', '广州'],
    ['帮我看看深圳的天气', '深圳'],
    ['成都天气', '成都'],
  ])('提取城市：%s → %s', (text, city) => {
    expect(extractWeatherCity(text)).toBe(city)
  })
  it.each(['今天天气怎么样', '天气怎么样', '多少度', '会不会下雨', '现在天气'])(
    '无城市名返回 null：%s', (text) => {
      expect(extractWeatherCity(text)).toBeNull()
    },
  )
})

describe('weather skill：onDirectCommand（源可注入替换）', () => {
  function makeCtx(): { ctx: SkillContext; spoken: string[] } {
    const spoken: string[] = []
    const ctx: SkillContext = {
      lang: 'zh-CN', timezone: 'Asia/Shanghai', deviceId: 'dev-1',
      data: {} as unknown as SkillContext['data'], memoryStore: undefined, agent: null,
      send: () => {}, speak: async (t) => { spoken.push(t) }, queueRemaining: () => 0,
    }
    return { ctx, spoken }
  }

  const samplePayload = {
    current: { temperature_2m: 21, apparent_temperature: 22, relative_humidity_2m: 60, weather_code: 1, wind_speed_10m: 3 },
  }

  it('命中天气 → 用注入的源口播（换源不改 skill）', async () => {
    const { ctx, spoken } = makeCtx()
    const source = {
      name: 'mock',
      fetch: async () => samplePayload,
      fetchCity: async (city: string) => ({ ...samplePayload, city }),
    }
    const skill = createWeatherSkill(source as never).create(ctx)
    const r = await skill.onDirectCommand?.('北京天气怎么样')
    expect(r?.consumed).toBe(true)
    expect(spoken[0]).toContain('北京')
  })

  it('源抛错 → 口播友好兜底、仍消费', async () => {
    const { ctx, spoken } = makeCtx()
    const source = { name: 'bad', fetch: async () => { throw new Error('net') } }
    const skill = createWeatherSkill(source as never).create(ctx)
    const r = await skill.onDirectCommand?.('今天天气怎么样')
    expect(r?.consumed).toBe(true)
    expect(spoken[0]).toContain('天气')
  })

  it('非天气句不消费', async () => {
    const { ctx, spoken } = makeCtx()
    const skill = createWeatherSkill({ name: 'x', fetch: async () => samplePayload } as never).create(ctx)
    const r = await skill.onDirectCommand?.('播放音乐')
    expect(r?.consumed).toBeFalsy()
    expect(spoken).toHaveLength(0)
  })
})
