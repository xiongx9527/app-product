#!/usr/bin/env node
/**
 * USB 联网 —— Android 真机借用电脑的网络（reverse tethering，不需要 WiFi / 热点）。
 *
 * 为什么需要：真机联调常在「有 USB、没 WiFi（或 WiFi 开了 AP 隔离）」的环境里跑，
 * 设备自己上不了外网；而 `adb reverse` 只会把设备上某个 TCP 端口反代到本机，不提供默认路由。
 * 这里用「本机 HTTP 代理 + adb reverse + 设备全局代理」把设备的 HTTP(S) 流量引到本机出口：
 *
 *   设备 App → 127.0.0.1:<port>（设备侧由 adb reverse 监听）
 *            → USB → 本机 127.0.0.1:<port>（本脚本内置代理）
 *            → 本机网络 → 互联网
 *
 * 限制（必须知道）：
 *   - 只覆盖「遵守系统代理」的 App（浏览器 / WebView / OkHttp 等）。不读系统代理的 App、原生 socket
 *     直连、以及设备上的 Node（内嵌网关）不会走这里。需要全量隧道请上 gnirehtet 这类 VPN 方案。
 *   - 代理只监听 127.0.0.1，靠 adb reverse 暴露给「当前 USB 连着的这台设备」，不开放到局域网。
 *   - 设备侧任何 App 的 HTTP(S) 请求都会带本机 IP 出去（明文 HTTP 内容会经过本机代理，仅内网调试用）。
 *   - adb reverse 会随「拔线 / 重启设备 / 重启 adb」失效，重插后重跑 `up` 即可（幂等）。
 *
 * 用法（macOS / Linux 可用同目录 usb-net.sh，Windows 用 usb-net.bat，参数一致）：
 *   node scripts/usb-net.mjs up        # 起代理 + 逐台 adb reverse + 写设备全局代理（幂等，可重复执行）
 *   node scripts/usb-net.mjs down      # 逐台清设备代理 + 删 adb reverse + 停本机代理（恢复原状）
 *   node scripts/usb-net.mjs status    # 看每台 USB 设备的代理 / 反代 / 本机代理状态
 *   node scripts/usb-net.mjs serve     # 只在前台跑代理（up 会自动拉后台，无需手动执行）
 *
 * 默认对「所有 USB 在线的 Android 设备」生效（模拟器 / WiFi adb 不算）；多台设备共用同一个本机代理端口。
 *
 * 参数：
 *   --port <端口>     本机代理端口，默认 8899（也可用环境变量 USB_NET_PORT）
 *   --serial <序列号> 只处理指定设备，可逗号分隔多台（默认全部 USB 设备；也可用 USB_NET_SERIAL）
 *
 * 日志与 pid：xiaoxiong-app/logs/usb-net.log、xiaoxiong-app/logs/.usb-net.pid（均已 gitignore）。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const APP_ROOT = dirname(dirname(SCRIPT_PATH)) // xiaoxiong-app
const LOGS_DIR = join(APP_ROOT, 'logs')
const PID_PATH = join(LOGS_DIR, '.usb-net.pid')
const LOG_PATH = join(LOGS_DIR, 'usb-net.log')

const DEFAULT_PORT = 8899
const HEALTH_PATH = '/__usbnet/health'
// 自检目标：用国内可达的站点验证「设备 → 代理 → 外网」，避免 example.com 在部分网络下不通造成误报。
const EGRESS_HTTP = 'http://www.baidu.com'
const EGRESS_HTTPS = 'https://www.baidu.com'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────────────────────── 参数 ─────────────────────────────

function parseArgs(argv) {
  const out = {
    cmd: '',
    port: Number(process.env.USB_NET_PORT || DEFAULT_PORT),
    serial: process.env.USB_NET_SERIAL || '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length))
    else if (a === '--serial') out.serial = argv[++i] || ''
    else if (a.startsWith('--serial=')) out.serial = a.slice('--serial='.length)
    else if (a === '-h' || a === '--help') out.cmd = 'help'
    else if (!out.cmd) out.cmd = a
  }
  if (!out.cmd) out.cmd = 'up'
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    throw new Error(`端口不合法: ${out.port}（应为 1-65535）`)
  }
  return out
}

// ───────────────────────────── adb ─────────────────────────────

function resolveAdb() {
  const candidates = []
  if (process.env.ADB) candidates.push(process.env.ADB)
  candidates.push('adb')
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (sdk) candidates.push(join(sdk, 'platform-tools', 'adb'))
  }
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ['version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return cmd
  }
  return ''
}

function makeAdb(adb, serial) {
  const base = ['-s', serial]
  const run = (args) => spawnSync(adb, [...base, ...args], { encoding: 'utf8' })
  const capture = (args) => {
    const r = run(args)
    if (r.error) throw r.error
    if (r.status !== 0) {
      throw new Error(`adb ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`)
    }
    return (r.stdout || '').trim()
  }
  return { adb, base, run, capture }
}

function describeDevices(adb) {
  const r = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

/** 列出所有 USB 在线的 Android 设备序列号（排除模拟器 / WiFi adb）。 */
function listUsbDevices(adb) {
  const rows = (spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' }).stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('List of devices'))
  const devices = rows
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/)
      return { serial, state, meta: rest.join(' ') }
    })
    .filter((d) => d.state === 'device')
  // 新 adb 会带 usb: 字段；老 adb 没有时按「非模拟器、非网络序列号（含冒号）」兜底
  const usb = devices.filter((d) => /\busb:/.test(d.meta))
  const picked = usb.length
    ? usb
    : devices.filter((d) => !d.serial.startsWith('emulator-') && !d.serial.includes(':'))
  return picked.map((d) => d.serial)
}

/** 目标设备：--serial（可逗号分隔多台），缺省即全部 USB 设备。 */
function resolveTargets(adb, serialOpt) {
  if (serialOpt) {
    const list = serialOpt
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const bad = list.filter((serial) => {
      const st = spawnSync(adb, ['-s', serial, 'get-state'], { encoding: 'utf8' })
      return st.status !== 0 || (st.stdout || '').trim() !== 'device'
    })
    if (bad.length) {
      throw new Error(`指定的设备不可用: ${bad.join(', ')}。当前设备列表：\n${describeDevices(adb)}`)
    }
    return list
  }
  const list = listUsbDevices(adb)
  if (list.length === 0) {
    throw new Error('没有 USB 在线的 Android 设备。请插好线、开启 USB 调试并授权后重试。')
  }
  return list
}

// ───────────────────────────── 本机代理 ─────────────────────────────

function proxyHealth(port, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

async function ensureProxy(port) {
  if (await proxyHealth(port)) return { started: false }
  mkdirSync(LOGS_DIR, { recursive: true })
  const fd = openSync(LOG_PATH, 'a')
  const child = spawn(process.execPath, [SCRIPT_PATH, 'serve', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  })
  closeSync(fd) // 子进程已继承日志 fd，父进程这份可以关掉
  child.unref()
  for (let i = 0; i < 40; i += 1) {
    await sleep(100)
    if (await proxyHealth(port)) return { started: true, pid: child.pid }
    if (child.exitCode !== null) break
  }
  throw new Error(`本机代理未能启动（端口 ${port} 可能被占用）。见日志：${LOG_PATH}`)
}

async function stopProxy() {
  let pid = 0
  if (existsSync(PID_PATH)) {
    const raw = readFileSync(PID_PATH, 'utf8').trim()
    pid = Number(raw) || 0
  }
  if (!pid) return false
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  if (alive) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 进程可能刚好退出，忽略
    }
    for (let i = 0; i < 20; i += 1) {
      await sleep(100)
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
        break
      }
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
  try {
    unlinkSync(PID_PATH)
  } catch {
    // 已删除
  }
  return true
}

function logLine(msg) {
  const t = new Date().toTimeString().slice(0, 8)
  console.log(`[${t}] ${msg}`)
}

/** 前台运行代理：up 会把本命令以 detached 方式拉起，一般不用手动执行。 */
function runProxy(port) {
  const startedAt = Date.now()

  const handleRequest = (req, res) => {
    if (req.url === HEALTH_PATH) {
      const body = JSON.stringify({ ok: true, port, uptime: Math.round((Date.now() - startedAt) / 1000) })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
      return
    }
    let target
    try {
      target = new URL(req.url || '')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('usb-net proxy: 需要绝对 URL（代理请求格式）')
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`usb-net proxy: 不支持的协议 ${target.protocol}`)
      return
    }
    const secure = target.protocol === 'https:'
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const upstream = (secure ? https : http).request(
      {
        method: req.method,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (up) => {
        logLine(`${req.method} ${target.href} → ${up.statusCode}`)
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      logLine(`${req.method} ${target.href} ✗ ${err.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`usb-net proxy error: ${err.message}`)
    })
    req.pipe(upstream)
  }

  const handleConnect = (req, socket, head) => {
    const raw = req.url || ''
    const idx = raw.lastIndexOf(':')
    const host = idx >= 0 ? raw.slice(0, idx) : raw
    const portNum = idx >= 0 ? Number(raw.slice(idx + 1)) : 443
    logLine(`CONNECT ${host}:${portNum}`)
    const upstream = net.connect(portNum, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    let closed = false
    const shutdown = (reason) => {
      if (closed) return
      closed = true
      if (reason) logLine(`CONNECT ${host}:${portNum} ✗ ${reason}`)
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', (err) => shutdown(err.message))
    socket.on('error', (err) => shutdown(err.message))
    socket.on('close', () => shutdown(''))
    upstream.on('close', () => shutdown(''))
    // 长连接保活由客户端决定；5 分钟无数据视为死连接，回收避免 fd 泄漏
    socket.setTimeout(5 * 60 * 1000, () => shutdown('idle timeout'))
  }

  const server = http.createServer(handleRequest)
  server.on('connect', handleConnect)
  server.on('clientError', (_err, socket) => socket.destroy())
  server.on('error', (err) => {
    console.error(`usb-net proxy 启动失败: ${err.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    mkdirSync(LOGS_DIR, { recursive: true })
    writeFileSync(PID_PATH, String(process.pid))
    console.log(`usb-net proxy listening on 127.0.0.1:${port} (pid ${process.pid})`)
  })

  const cleanup = () => {
    try {
      if (existsSync(PID_PATH) && readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) {
        unlinkSync(PID_PATH)
      }
    } catch {
      // pid 文件可能已被清理
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
}

// ───────────────────────────── 设备侧操作 ─────────────────────────────

function setDeviceProxy(cmd, port) {
  cmd.capture(['shell', `settings put global http_proxy 127.0.0.1:${port}`])
  const got = cmd.capture(['shell', 'settings get global http_proxy'])
  if (got !== `127.0.0.1:${port}`) {
    throw new Error(`设备代理写入失败（当前值: ${got || 'null'}）。部分定制 ROM 需手动在「设置 → WLAN → 代理」里填 127.0.0.1:${port}`)
  }
}

function clearDeviceProxy(cmd) {
  try {
    cmd.capture(['shell', 'settings delete global http_proxy'])
  } catch {
    // 老系统没有 delete 子命令时退回 :0（系统同样视为无代理）
    cmd.capture(['shell', 'settings put global http_proxy :0'])
  }
}

function ensureReverse(cmd, port) {
  const list = cmd.capture(['reverse', '--list'])
  if (!list.includes(`tcp:${port} tcp:${port}`)) {
    cmd.capture(['reverse', `tcp:${port}`, `tcp:${port}`])
  }
}

function removeReverse(cmd, port) {
  try {
    cmd.capture(['reverse', '--remove', `tcp:${port}`])
  } catch {
    // 本来就不存在
  }
}

function deviceSelfCheck(cmd, port) {
  const hasCurl = spawnSync(cmd.adb, [...cmd.base, 'shell', 'command -v curl'], { encoding: 'utf8' })
  if (hasCurl.status !== 0 || !(hasCurl.stdout || '').trim()) return { hasCurl: false }
  const run = (url) => {
    const r = spawnSync(
      cmd.adb,
      [...cmd.base, 'shell', `curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 8 -x http://127.0.0.1:${port} '${url}'`],
      { encoding: 'utf8' },
    )
    const code = (r.stdout || '').trim()
    return r.status === 0 && /^[0-9]{3}$/.test(code) ? code : ''
  }
  return { hasCurl: true, http: run(EGRESS_HTTP), https: run(EGRESS_HTTPS) }
}

// ───────────────────────────── 子命令 ─────────────────────────────

function printUsage() {
  console.log(`用法:
  usb-net.mjs up        起代理 + 逐台 adb reverse + 写设备全局代理（幂等）
  usb-net.mjs down      逐台清设备代理 + 删 adb reverse + 停本机代理
  usb-net.mjs status    查看每台 USB 设备的代理 / 反代 / 本机代理状态
  usb-net.mjs serve     前台跑代理（内部用）

默认对「所有 USB 在线的 Android 设备」生效（模拟器 / WiFi adb 不算）。

参数:
  --port <端口>         默认 ${DEFAULT_PORT}（或用 USB_NET_PORT）
  --serial <序列号>     只处理指定设备，可逗号分隔多台（默认全部 USB 设备；或用 USB_NET_SERIAL）`)
}

async function cmdUp(adb, opts) {
  const devices = resolveTargets(adb, opts.serial)
  console.log(`==> USB 设备（${devices.length} 台）: ${devices.join(', ')}`)

  console.log(`\n==> [1/3] 本机代理 127.0.0.1:${opts.port}`)
  const proxy = await ensureProxy(opts.port)
  console.log(`    ${proxy.started ? `已启动 (pid ${proxy.pid})` : '复用已在运行的代理'}`)

  console.log('\n==> [2/3] 逐台建链（adb reverse + 全局代理）')
  const failures = []
  const ready = []
  for (const serial of devices) {
    const cmd = makeAdb(adb, serial)
    try {
      ensureReverse(cmd, opts.port)
      setDeviceProxy(cmd, opts.port)
      ready.push(serial)
      console.log(`  ── ${serial} ✓  tcp:${opts.port} 已反代，http_proxy=127.0.0.1:${opts.port}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${serial}: ${msg}`)
      console.log(`  ── ${serial} ✗  ${msg}`)
    }
  }

  console.log('\n==> [3/3] 自检（设备 → 代理 → 外网）')
  for (const serial of ready) {
    const cmd = makeAdb(adb, serial)
    const check = deviceSelfCheck(cmd, opts.port)
    if (!check.hasCurl) {
      console.log(`  ── ${serial}  无 curl，跳过自检`)
      continue
    }
    const mark = (c) => (c ? `${c} ✓` : '失败 ✗')
    console.log(`  ── ${serial}  HTTP ${mark(check.http)}  HTTPS ${mark(check.https)}`)
    if (!check.http || !check.https) {
      console.log('     提示：链路已建立，但外网不通时先确认电脑本身能上网；')
      console.log('           若设备无 WiFi/移动数据，部分 App 仍会因「系统无网络」不发请求。')
    }
  }

  for (const f of failures) console.error(`[warn] ${f}`)
  console.log('\n完成：遵守系统代理的 App（浏览器 / WebView / OkHttp 等）现在走电脑网络。')
  console.log('恢复原状：scripts/usb-net.sh down（Windows 用 scripts\\usb-net.bat down）')
  console.log(`日志：${LOG_PATH}`)
  if (failures.length) process.exitCode = 1
}

async function cmdDown(adb, opts) {
  const failures = []
  if (adb) {
    let devices = []
    try {
      devices = resolveTargets(adb, opts.serial)
    } catch (err) {
      console.log(`==> ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
    if (devices.length) console.log(`==> 逐台清理（${devices.length} 台）`)
    for (const serial of devices) {
      const cmd = makeAdb(adb, serial)
      try {
        clearDeviceProxy(cmd)
        removeReverse(cmd, opts.port)
        console.log(`  ── ${serial} ✓  已清除全局代理与 tcp:${opts.port} 反代`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${serial}: ${msg}`)
        console.log(`  ── ${serial} ✗  ${msg}`)
      }
    }
    if (!devices.length) {
      console.log('    设备侧如仍有 http_proxy 残留，重连后重跑 down 即可清理')
    }
  } else {
    failures.push('找不到 adb，设备侧代理未清理')
  }
  const stopped = await stopProxy()
  console.log(stopped ? '==> 已停止本机代理' : '==> 本机代理未在运行')
  for (const f of failures) console.error(`[warn] ${f}`)
  if (failures.length) process.exitCode = 1
}

async function cmdStatus(adb, opts) {
  console.log('== 设备 ==')
  console.log(adb ? describeDevices(adb) : '（找不到 adb）')

  const rows = []
  if (adb) {
    const devices = opts.serial
      ? opts.serial.split(',').map((s) => s.trim()).filter(Boolean)
      : listUsbDevices(adb)
    console.log(`\n== USB 设备状态（${devices.length} 台）==`)
    if (!devices.length) console.log('（无 USB 设备）')
    for (const serial of devices) {
      const cmd = makeAdb(adb, serial)
      try {
        const proxySetting = cmd.capture(['shell', 'settings get global http_proxy']) || 'null'
        const reverse = cmd.capture(['reverse', '--list'])
        const hasRev = reverse.includes(`tcp:${opts.port} tcp:${opts.port}`)
        const hasProxy = proxySetting === `127.0.0.1:${opts.port}`
        rows.push({ ok: hasRev && hasProxy, configured: hasRev || hasProxy })
        console.log(
          `  ── ${serial}  代理: ${proxySetting}  反代 tcp:${opts.port}: ${hasRev ? '有' : '无'}  ${hasRev && hasProxy ? '已连通' : '未生效'}`,
        )
      } catch (err) {
        console.log(`  ── ${serial}  ✗ ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
  }

  console.log('\n== 本机代理 ==')
  const healthy = await proxyHealth(opts.port)
  const pid = existsSync(PID_PATH) ? readFileSync(PID_PATH, 'utf8').trim() : ''
  console.log(healthy ? `127.0.0.1:${opts.port} 运行中${pid ? `（pid ${pid}）` : ''}` : `127.0.0.1:${opts.port} 未运行`)

  const allOk = rows.length > 0 && rows.every((r) => r.ok) && healthy
  const anyConfigured = healthy || rows.some((r) => r.configured)
  if (allOk) console.log('\n状态：全部设备已连通（USB 联网生效）')
  else if (!anyConfigured) console.log('\n状态：未启用（node scripts/usb-net.mjs up 开启）')
  else console.log('\n状态：未完全生效，重跑 up 修正（node scripts/usb-net.mjs up）')
}

// ───────────────────────────── 入口 ─────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.cmd === 'help') {
    printUsage()
    return
  }
  if (opts.cmd === 'serve') {
    runProxy(opts.port)
    return
  }
  const adb = resolveAdb()
  if (!adb) {
    if (opts.cmd === 'up') throw new Error('找不到 adb，请确认 Android SDK platform-tools 在 PATH（或设置 ANDROID_HOME）')
    console.error('[warn] 找不到 adb，只能处理本机代理')
  }
  if (opts.cmd === 'up') await cmdUp(adb, opts)
  else if (opts.cmd === 'down') await cmdDown(adb, opts)
  else if (opts.cmd === 'status') await cmdStatus(adb, opts)
  else {
    printUsage()
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`[error] ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
