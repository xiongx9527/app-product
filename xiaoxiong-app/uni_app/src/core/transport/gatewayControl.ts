/**
 * 网关控制：轻量存活探测 + 点中间圆球/设置页手动重启网关。
 *
 * 背景：网关进程活着、WS 也连着，但 8787 事件循环卡死时 /api/health 因 15s 缓存仍绿，
 * 只有 /api/ping（不查健康、直接回 ok）能反映「此刻是否真活着」。用户遇到喊话/点球没反应
 * 时，前端 ping 一下确认卡死，再调原生重启网关恢复（不做自动自愈，避免误重启）。
 *
 * 跨平台：App 走 uni.request / uni.requireNativePlugin，H5 无原生插件走 fetch / 返回 false。
 */
import { resolveGatewayHttpBase } from './webSocketTransport'
import { appConfig } from '../config'

/**
 * 访问网关数据接口（/api/mcp/tools、/api/skills 等）的统一 GET：跨平台请求 + 超时只在这里写一次。
 * apiKey 由全局 uni.request 拦截器统一注入（见 requestInterceptor.ts）：App 端所有请求自动带，
 * 这里不再重复拼；H5 的 fetch 不受拦截器覆盖，故仅在 fetch 分支补一个头（唯一例外）。
 * 失败返回 null，由调用方决定提示。
 */
function gatewayGet(path: string, timeoutMs = 10000): Promise<unknown | null> {
  const url = `${resolveGatewayHttpBase()}${path}`
  const req = new Promise<unknown | null>((resolve) => {
    if (typeof uni !== 'undefined' && typeof uni.request === 'function') {
      // App 端：apiKey 由全局拦截器统一注入，这里只给 accept
      uni.request({
        url, method: 'GET', header: { accept: 'application/json' },
        success: (res) => resolve(res.data),
        fail: () => resolve(null),
      })
      return
    }
    if (typeof fetch !== 'undefined') {
      // H5 fetch 不走 uni.request 拦截器，唯一在此补 apiKey
      const header: Record<string, string> = { accept: 'application/json' }
      if (appConfig.voice.builtin.apiKey) header['x-voice-api-key'] = appConfig.voice.builtin.apiKey
      fetch(url, { cache: 'no-store', headers: header })
        .then((r) => r.json()).then(resolve)
        .catch(() => resolve(null))
      return
    }
    resolve(null)
  })
  return withTimeout(req, timeoutMs).catch(() => null)
}

/** 工具入参字段说明（与网关 /api/mcp/tools 的 params 契约一致）。 */
export interface GatewayMcpParam {
  name: string
  type: string
  description: string
  required: boolean
}

/** MCP 工具清单条目（与网关 /api/mcp/tools 契约一致）。 */
export interface GatewayMcpTool {
  name: string
  description: string
  params: GatewayMcpParam[]
}

/** 拉取 MCP 已注册工具清单：后端 token 换发透明处理，apiKey 由全局拦截器统一注入。 */
export function fetchGatewayMcpTools(timeoutMs = 10000): Promise<{ ok: boolean; tools: GatewayMcpTool[]; error?: string }> {
  return gatewayGet('/api/mcp/tools', timeoutMs).then((d) => {
    const obj = (d ?? {}) as { ok?: boolean; tools?: GatewayMcpTool[]; error?: string }
    return { ok: !!obj.ok, tools: Array.isArray(obj.tools) ? obj.tools : [], error: obj.error }
  })
}

/** 远端 Skill 清单条目（与网关 /api/skills 契约一致）：content 为 markdown 正文，供设置页展开查看。 */
export interface GatewaySkill {
  name: string
  description: string
  content?: string
}

/** 拉取 19529 上的 Skill 清单（经网关 /api/skills 转发）：设置页「Skill 设置」列表用。 */
export function fetchGatewaySkills(timeoutMs = 10000): Promise<{ ok: boolean; skills: GatewaySkill[]; error?: string }> {
  return gatewayGet('/api/skills', timeoutMs).then((d) => {
    const obj = (d ?? {}) as { ok?: boolean; skills?: GatewaySkill[]; error?: string }
    return { ok: !!obj.ok, skills: Array.isArray(obj.skills) ? obj.skills : [], error: obj.error }
  })
}

/** 带超时的 Promise 兜底：uni.request 无原生超时参数，靠它防挂死。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('gateway probe timeout')), ms)),
  ])
}

/** GET 轻量 ping：网关 8787 事件循环此刻是否活着（2s 内出结果）。 */
export function pingGateway(timeoutMs = 2000): Promise<boolean> {
  const url = `${resolveGatewayHttpBase()}/api/ping`
  const req = new Promise<boolean>((resolve) => {
    if (typeof uni !== 'undefined' && typeof uni.request === 'function') {
      uni.request({
        url,
        method: 'GET',
        header: { accept: 'application/json' },
        success: (res) => resolve(res.statusCode >= 200 && res.statusCode < 300 && !!(res.data as { ok?: boolean })?.ok),
        fail: () => resolve(false),
      })
      return
    }
    if (typeof fetch !== 'undefined') {
      fetch(url, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d: { ok?: boolean }) => resolve(!!d?.ok))
        .catch(() => resolve(false))
      return
    }
    resolve(false)
  })
  return withTimeout(req, timeoutMs).catch(() => false)
}

/**
 * 轮询 ping 等网关恢复：重启发起后调用，最多等 timeoutMs。
 * 网关重启要杀旧进程+重新解包+起 node，通常 2-5s；给足 30s。
 */
export async function waitGatewayAlive(timeoutMs = 30000, pollMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingGateway()) return true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

/**
 * 调原生重启网关（Android 重启 :gateway 进程 / iOS 软重启网关引擎）。
 * 原生插件 app-product-gateway 未注入（H5/旧基座）时返回 false，由调用方降级提示。
 */
export function restartGatewayViaNative(timeoutMs = 8000): Promise<boolean> {
  const plugin = typeof uni !== 'undefined' && typeof uni.requireNativePlugin === 'function'
    ? uni.requireNativePlugin('app-product-gateway')
    : null
  if (!plugin || typeof plugin.restartGateway !== 'function') {
    console.info('[gateway-control] 原生重启网关接口不可用（H5/旧基座），降级')
    return Promise.resolve(false)
  }
  // 【不依赖回调判定成败】weex/DCloud 桥的 invokeAndKeepAlive payload 形态极不稳定
  // （对象 / JSON 字符串 / boolean 都出现过，Android 实测原生已执行重启却被解析成 false、
  // 界面误报"不支持"）。只要原生方法存在且调用没抛异常，就认为"已发起重启"返回 true；
  // 网关是否真恢复由调用方用 waitForEmbeddedGateway / ping 做权威判断。回调仅用于日志。
  // 真正"不支持"只在插件缺失或方法不存在时（H5 / 旧基座）返回 false。
  try {
    plugin.restartGateway((r: unknown) => {
      console.info('[gateway-control] restartGateway callback=' + (typeof r === 'string' ? r : JSON.stringify(r)))
    })
    return Promise.resolve(true)
  } catch (e) {
    console.warn('[gateway-control] restartGateway 调用异常', e)
    return Promise.resolve(false)
  }
}
