import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectRuntimeEnv,
  readAppPermissions,
  readAppPermissionsSync,
  readBrowserPermissions,
  applyMicEvidence,
  type RuntimeEnv,
} from './permissionStatus'
import { toPermissionItems } from '@/features/assistant/usePermissions'

interface ScopeShape {
  uni?: unknown
  navigator?: unknown
  window?: unknown
}

function setScope(value: ScopeShape): void {
  const g = globalThis as unknown as ScopeShape
  for (const key of ['uni', 'navigator', 'window'] as const) {
    // 先清干净，避免上一次用例残留（Node 自带全局 navigator 也要能被覆盖）
    delete g[key]
    if (key in value) (g as Record<string, unknown>)[key] = (value as Record<string, unknown>)[key]
  }
}

afterEach(() => {
  setScope({})
})

describe('detectRuntimeEnv 环境判定（目标端仅 App / H5）', () => {
  it('uniPlatform=app → app', () => {
    setScope({ uni: { getSystemInfoSync: () => ({ uniPlatform: 'app' }) } })
    expect(detectRuntimeEnv()).toBe('app')
  })

  it('uniPlatform=web → h5', () => {
    setScope({ uni: { getSystemInfoSync: () => ({ uniPlatform: 'web' }) } })
    expect(detectRuntimeEnv()).toBe('h5')
  })

  it('小程序 / 鸿蒙不是目标端 → unknown（不写专门分支，走只读兜底）', () => {
    setScope({ uni: { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }) } })
    expect(detectRuntimeEnv()).toBe('unknown')
    setScope({ uni: { getSystemInfoSync: () => ({ uniPlatform: 'app-harmony' }) } })
    expect(detectRuntimeEnv()).toBe('unknown')
  })

  it('纯浏览器（window + navigator）→ h5；都没有 → unknown', () => {
    setScope({ window: {}, navigator: { userAgent: 'test' } })
    expect(detectRuntimeEnv()).toBe('h5')
    setScope({})
    expect(detectRuntimeEnv()).toBe('unknown')
  })
})

describe('按环境分流：每个环境只用它对应的那套 API', () => {
  it('App 环境只调 getAppAuthorizeSetting，不碰 navigator', async () => {
    const getAppAuthorizeSetting = vi.fn(() => ({
      microphoneAuthorized: 'authorized',
      locationAuthorized: 'denied',
    }))
    const query = vi.fn()
    setScope({
      uni: { getSystemInfoSync: () => ({ uniPlatform: 'app' }), getAppAuthorizeSetting },
      navigator: { permissions: { query } },
    })
    expect(await readAppPermissions()).toEqual({ mic: 'granted', location: 'denied' })
    expect(getAppAuthorizeSetting).toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('H5 环境只调 navigator.permissions.query，不碰 uni 权限 API', async () => {
    const query = vi.fn(async ({ name }: { name: string }) => ({
      state: name === 'microphone' ? 'granted' : 'prompt',
    }))
    const getAppAuthorizeSetting = vi.fn()
    setScope({
      window: {},
      navigator: { userAgent: 'test', permissions: { query } },
      uni: { getSystemInfoSync: () => ({ uniPlatform: 'web' }), getAppAuthorizeSetting },
    })
    expect(await readAppPermissions()).toEqual({ mic: 'granted', location: 'unknown' })
    expect(query).toHaveBeenCalledTimes(2)
    expect(getAppAuthorizeSetting).not.toHaveBeenCalled()
  })

  it('H5 浏览器不支持 Permissions API 时返回全 unknown（不误报未授权）', async () => {
    setScope({ window: {}, navigator: { userAgent: 'test' }, uni: { getSystemInfoSync: () => ({ uniPlatform: 'web' }) } })
    expect(await readAppPermissions()).toEqual({ mic: 'unknown', location: 'unknown' })
  })

  it('环境未知（非目标端兼容层）只读合并两套来源，不误报', async () => {
    const query = vi.fn(async () => ({ state: 'granted' }))
    setScope({
      window: {},
      navigator: { userAgent: 'test', permissions: { query } },
      uni: { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }) },
    })
    expect(await readAppPermissions()).toEqual({ mic: 'granted', location: 'granted' })
  })
})

describe('权限只读检测：绝不申请授权、不弹框', () => {
  it('App 端 authorized/denied 精确映射', () => {
    setScope({
      uni: {
        getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'authorized', locationAuthorized: 'denied' }),
      },
    })
    expect(readAppPermissionsSync()).toEqual({ mic: 'granted', location: 'denied' })
  })

  it('not determined / config error / 字段缺失一律 unknown，不误报成未授权', () => {
    setScope({
      uni: {
        getSystemInfoSync: () => ({ uniPlatform: 'app' }),
        getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'not determined', locationAuthorized: 'config error' }),
      },
    })
    expect(readAppPermissionsSync()).toEqual({ mic: 'unknown', location: 'unknown' })
  })

  it('全程不调用 uni.authorize（守住「不冷启动弹权限框」约束）', async () => {
    const authorize = vi.fn()
    setScope({
      uni: {
        getSystemInfoSync: () => ({ uniPlatform: 'app' }),
        getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'denied' }),
        authorize,
      },
    })
    await readAppPermissions()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('浏览器 query 抛错（如 Safari 不认识 microphone）也不误报', async () => {
    setScope({
      window: {},
      navigator: { permissions: { query: async () => { throw new Error('unsupported') } } },
    })
    expect(await readBrowserPermissions()).toEqual({ mic: 'unknown', location: 'unknown' })
  })
})

describe('麦克风事实证据：能唤醒=已授权，覆盖误报', () => {
  it('micGranted=true 时把 mic 覆盖为 granted，不影响 location', () => {
    expect(applyMicEvidence({ mic: 'unknown', location: 'unknown' }, true)).toEqual({
      mic: 'granted',
      location: 'unknown',
    })
    expect(applyMicEvidence({ mic: 'denied', location: 'denied' }, true)).toEqual({
      mic: 'granted',
      location: 'denied',
    })
  })

  it('micGranted=false 时不改原结果', () => {
    expect(applyMicEvidence({ mic: 'unknown', location: 'granted' }, false)).toEqual({
      mic: 'unknown',
      location: 'granted',
    })
  })

  it('H5 权限 API 拿不到 + 录音已成功 → 麦克风显示绿（用户实测「能唤醒却是黄点」修复）', async () => {
    const env: RuntimeEnv = 'h5'
    setScope({ window: {}, navigator: { userAgent: 'test' } })
    expect(await readAppPermissions({ env, micGranted: true })).toEqual({
      mic: 'granted',
      location: 'unknown',
    })
  })

  it('授权 API 明确返回 denied 也不应被陈旧实证误覆盖（实证由调用方按当前采集状态给）', async () => {
    setScope({
      uni: {
        getSystemInfoSync: () => ({ uniPlatform: 'app' }),
        getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'denied' }),
      },
    })
    expect(await readAppPermissions({ micGranted: false })).toEqual({ mic: 'denied', location: 'unknown' })
  })
})

describe('toPermissionItems 三色映射与顺序', () => {
  it('麦克风排在定位前（都放在 LLM 前），三色对应 granted/denied/unknown', () => {
    const items = toPermissionItems({ mic: 'denied', location: 'granted' })
    expect(items.map((i) => i.key)).toEqual(['mic', 'location'])
    expect(items.map((i) => i.status)).toEqual(['down', 'ok'])
  })

  it('unknown 显示黄色 warn，不冒充故障红', () => {
    expect(toPermissionItems({ mic: 'unknown', location: 'unknown' }).map((i) => i.status)).toEqual([
      'warn',
      'warn',
    ])
  })
})
