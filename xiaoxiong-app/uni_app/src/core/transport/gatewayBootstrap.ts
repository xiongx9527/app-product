import { DEFAULT_GATEWAY_WS_URL } from '@/core/config/constants'

/**
 * 嵌入式网关引导：App 启动时原生 :gateway 进程把实际 WS 地址写到
 * getFilesDir()/gateway.url（见原生 GatewayNodeService.pollPort）。本模块在
 * APP-PLUS（Android/iOS）下用 plus.io 读出该地址，让 WebSocketTransport 连回环端口；
 * H5 / 开发 / 单测环境没有 plus，直接回退构建期 VITE_GATEWAY_WS_URL 或内置默认，行为不变。
 *
 * 注意：plus.io 的各 root 与 Android getFilesDir()（/data/data/<pkg>/files）的精确映射
 * 无法在开发机真机验证，这里 best-effort 逐个 root 探测 gateway.url 并兜底；若某机型
 * 实际路径不在下列 root 内，需设备验证后补充（详见本文件底部说明）。
 */

/** 原生写出的网关 WS 地址文件名（含 /ws 路径）。 */
const GATEWAY_URL_FILE = 'gateway.url'

/** 运行环境是否内嵌了原生网关（仅 APP-PLUS 才有 plus 运行时）。 */
export function isEmbeddedGateway(): boolean {
  // H5 / 浏览器 / 单测：plus 未定义，必为 false。
  return typeof plus !== 'undefined'
}

/** 回退地址：构建期 VITE_GATEWAY_WS_URL，未注入则用内置默认（与后端默认端口对齐）。 */
function fallbackWsUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = metaEnv?.VITE_GATEWAY_WS_URL?.trim()
  if (fromMeta) return fromMeta
  if (typeof process !== 'undefined') {
    const fromProc = process.env?.VITE_GATEWAY_WS_URL?.trim()
    if (fromProc) return fromProc
  }
  return DEFAULT_GATEWAY_WS_URL
}

// ---- plus.io 最小接口（仅覆盖本模块用到的读写能力，避免依赖完整 Plus 类型细节）----
interface PlusFile {
  // File 对象本身只作为 readAsText 入参，无需具体字段
}
interface PlusFileEntry {
  file: (success: (file: PlusFile) => void, fail?: () => void) => void
}
interface PlusDirectoryEntry {
  getFile: (
    path: string,
    options: { create: boolean },
    success: (entry: PlusFileEntry) => void,
    fail?: () => void,
  ) => void
}
interface PlusFileSystem {
  root: PlusDirectoryEntry
}
interface PlusIoFileReader {
  onloadend: (() => void) | null
  onerror: (() => void) | null
  readAsText: (file: unknown) => void
  result: string | ArrayBuffer | null
}
interface PlusIo {
  PRIVATE_DOC: number
  APPLICATION: number
  PRIVATE_WWW: number
  PUBLIC_DOCUMENTS: number
  requestFileSystem: (
    type: number,
    success: (fs: PlusFileSystem) => void,
    fail?: () => void,
  ) => void
  FileReader: { new (): PlusIoFileReader }
}

/**
 * 尝试从某个 plus.io root 下读取 gateway.url。读取失败/不存在一律返回 null，
 * 不抛错（best-effort，调用方会尝试下一个 root 或回退）。
 */
function readUrlFromRoot(io: PlusIo, rootType: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      io.requestFileSystem(
        rootType,
        (fs) => {
          fs.root.getFile(
            GATEWAY_URL_FILE,
            { create: false },
            (entry) => {
              entry.file(
                (file) => {
                  const reader = new io.FileReader()
                  reader.onloadend = () => {
                    const text =
                      typeof reader.result === 'string' ? reader.result.trim() : ''
                    resolve(text || null)
                  }
                  reader.onerror = () => resolve(null)
                  reader.readAsText(file)
                },
                () => resolve(null),
              )
            },
            () => resolve(null),
          )
        },
        () => resolve(null),
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 仅内嵌模式下从 plus.io 读取原生进程写出的 gateway.url；读不到（进程还没起 /
 * 路径未命中 / 非 APP-PLUS）一律返回 null，不回退。供「等待网关就绪」轮询使用，
 * 以便区分「真实拿到了内嵌地址」与「只能用默认回退地址」。
 */
export async function readEmbeddedGatewayUrl(): Promise<string | null> {
  if (typeof plus === 'undefined') return null
  const io = (plus as unknown as { io?: PlusIo }).io
  if (!io || typeof io.requestFileSystem !== 'function') return null

  // 依次探测常见 root；getFilesDir() 实际落在哪个 root 取决于系统/SDK 版本，
  // 故全部尝试，第一个非空结果即返回（需设备验证，见文件顶部说明）。
  const roots = [
    io.PRIVATE_DOC,
    io.APPLICATION,
    io.PRIVATE_WWW,
    io.PUBLIC_DOCUMENTS,
  ]
  for (const root of roots) {
    if (root === undefined) continue
    const content = await readUrlFromRoot(io, root)
    if (content) return content
  }
  return null
}

/**
 * 取嵌入式网关的 WS 地址：
 *  APP-PLUS 下逐个 plus.io root 探测 gateway.url，命中即用；
 *  任何 root 读不到或环境不是 APP-PLUS，回退 VITE_GATEWAY_WS_URL / 默认。
 * 整个流程永不抛错，保证连接不因此中断。
 */
export async function getGatewayWsUrl(): Promise<string> {
  const embedded = await readEmbeddedGatewayUrl()
  return embedded ?? fallbackWsUrl()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WaitGatewayOptions {
  /** 最长等待内嵌网关就绪的时间，默认 15s。 */
  timeoutMs?: number
  /** 轮询间隔，默认 300ms。 */
  pollMs?: number
}

/**
 * 等待内嵌网关就绪：原生 :gateway 进程启动后才会写出 gateway.url，
 * enable() 前先等它就绪，避免连到默认回退地址而连不上、又静默失败。
 * - 非内嵌（H5 / 外部网关）：直接 resolve(true)，就绪由真实建连判断。
 * - 内嵌：轮询 gateway.url，命中即 true；超时（默认 15s）返回 false，
 *   由调用方显示 i18n 提示、不静默。
 */
export async function waitForEmbeddedGateway(
  options: WaitGatewayOptions = {},
): Promise<boolean> {
  if (!isEmbeddedGateway()) return true
  const timeoutMs = options.timeoutMs ?? 15000
  const pollMs = Math.max(50, options.pollMs ?? 300)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await readEmbeddedGatewayUrl()) return true
    await delay(pollMs)
  }
  return false
}
