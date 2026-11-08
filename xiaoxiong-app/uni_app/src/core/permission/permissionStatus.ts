/**
 * 设备权限只读检测：只查询「是否已授权」，绝不申请授权、不弹系统权限框。
 * 定位是非必须能力（仅天气/附近才用，授权本身走懒加载），这里只做状态展示；
 * 麦克风是语音唤醒/对话的核心能力，未授权时由上层播 mp3 提示音。
 *
 * 目标端只有 Android / iOS App（自定义基座）；H5 仅开发阶段调试用；
 * 微信小程序与 HarmonyOS 确定不支持，不为它们增加专门分支。
 * 必须先判环境、只走对应那一套读法，不能混着试：
 *  - App：uni.getAppAuthorizeSetting（同步，原生准确）
 *  - H5：navigator.permissions.query（异步，只读 Query 不弹框）
 * 拿不到的一律 unknown，不误报成「未授权」；麦克风另有「录音曾成功」的事实证据兜底。
 */

export type PermissionState = 'granted' | 'denied' | 'unknown'
export type RuntimeEnv = 'app' | 'h5' | 'unknown'

export interface AppPermissions {
  /** 麦克风：语音唤醒与语音对话的核心权限 */
  mic: PermissionState
  /** 定位：天气/附近等非必须增强能力 */
  location: PermissionState
}

type AppAuthorizeValue = 'authorized' | 'denied' | 'not determined' | 'config error'

interface AppAuthorizeSetting {
  microphoneAuthorized?: AppAuthorizeValue
  locationAuthorized?: AppAuthorizeValue
}

interface UniPermissionApi {
  getAppAuthorizeSetting?: () => AppAuthorizeSetting
  getSystemInfoSync?: () => { uniPlatform?: string }
}

/** 浏览器 Permissions API：只读查询，绝不触发授权弹框。Safari 等不支持时返回 null。 */
interface BrowserPermissionsApi {
  query?: (descriptor: { name: string }) => Promise<{ state: string }>
}

interface RuntimeScope {
  uni?: UniPermissionApi
  navigator?: { permissions?: BrowserPermissionsApi; userAgent?: string }
  window?: unknown
}

function runtimeScope(): RuntimeScope {
  return globalThis as unknown as RuntimeScope
}

/**
 * 判断当前运行环境。优先用 uni.getSystemInfoSync().uniPlatform，
 * 取不到（纯浏览器/单测）再按 window/navigator 兜底。
 * 小程序（mp-*）与鸿蒙（app-harmony）不是目标端，一律归 unknown，
 * 由默认分支做只读兜底，不为它们写专门路径。
 */
export function detectRuntimeEnv(): RuntimeEnv {
  const scope = runtimeScope()
  const platform = scope.uni?.getSystemInfoSync?.()?.uniPlatform
  if (platform === 'app') return 'app'
  if (platform === 'web') return 'h5'
  if (typeof scope.window !== 'undefined' && scope.navigator) return 'h5'
  return 'unknown'
}

function mapAppAuthorize(value: AppAuthorizeValue | undefined): PermissionState {
  if (value === 'authorized') return 'granted'
  if (value === 'denied') return 'denied'
  // not determined（从未申请过）/ config error（manifest 未声明）/ 字段缺失
  // 都不是「用户明确拒绝」，不能误报成未授权，统一按「未知」显示。
  return 'unknown'
}

/** App 端同步只读查询（uni.getAppAuthorizeSetting）：原生准确、不弹框；不支持返回 null。 */
export function readAppPermissionsSync(): AppPermissions | null {
  const uni = runtimeScope().uni
  const get = uni?.getAppAuthorizeSetting
  if (typeof get !== 'function') return null
  try {
    // 用 call 保住 uni 的 this 绑定：部分端实现会读 this 上的内部状态。
    const r = get.call(uni)
    if (!r) return null
    return {
      mic: mapAppAuthorize(r.microphoneAuthorized),
      location: mapAppAuthorize(r.locationAuthorized),
    }
  } catch {
    return null
  }
}

/**
 * H5/浏览器：Permissions API 只读查询（query 不弹授权框）。
 * granted → 绿，denied → 红，prompt/未支持/报错 → unknown（不误报）。
 */
export function readBrowserPermissions(): Promise<AppPermissions | null> {
  return new Promise((resolve) => {
    const api = runtimeScope().navigator?.permissions
    const query = api?.query
    if (typeof query !== 'function') {
      resolve(null)
      return
    }
    const readOne = async (name: string): Promise<PermissionState> => {
      try {
        const status = await query.call(api, { name })
        if (status.state === 'granted') return 'granted'
        if (status.state === 'denied') return 'denied'
        return 'unknown' // prompt（尚未询问）/ 其它
      } catch {
        return 'unknown' // 浏览器不认识该权限名
      }
    }
    Promise.all([readOne('microphone'), readOne('geolocation')])
      .then(([mic, location]) => resolve({ mic, location }))
      .catch(() => resolve(null))
  })
}

/**
 * 用「录音已成功」的事实证据覆盖误报：能采集到麦克风就一定是已授权
 * （没麦克风权限连手动唤醒都做不到），比任何权限查询 API 都可靠。
 * 只覆盖 mic，不影响定位。
 */
export function applyMicEvidence(base: AppPermissions, micGranted: boolean): AppPermissions {
  return micGranted ? { ...base, mic: 'granted' } : base
}

const UNKNOWN: AppPermissions = { mic: 'unknown', location: 'unknown' }

/** 逐字段取第一个「明确（granted/denied）」的结果，unknown 不掩盖后续来源。 */
function mergeKnown(base: AppPermissions, next: AppPermissions | null): AppPermissions {
  if (!next) return base
  return {
    mic: base.mic !== 'unknown' ? base.mic : next.mic,
    location: base.location !== 'unknown' ? base.location : next.location,
  }
}

/**
 * 按环境分流读取权限：App 只调 getAppAuthorizeSetting，H5 只调 Permissions API；
 * 环境未知（单测/非目标端兼容层）才做一次只读兜底合并。最后叠加麦克风实证。
 */
export async function readAppPermissions(
  options: { micGranted?: boolean; env?: RuntimeEnv } = {}
): Promise<AppPermissions> {
  const env = options.env ?? detectRuntimeEnv()
  let result: AppPermissions
  switch (env) {
    case 'app':
      result = readAppPermissionsSync() ?? { ...UNKNOWN }
      break
    case 'h5':
      result = (await readBrowserPermissions()) ?? { ...UNKNOWN }
      break
    default: {
      result = { ...UNKNOWN }
      result = mergeKnown(result, readAppPermissionsSync())
      result = mergeKnown(result, await readBrowserPermissions())
    }
  }
  return applyMicEvidence(result, options.micGranted === true)
}
