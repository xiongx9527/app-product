#!/usr/bin/env node
// 跨平台开发服务器管理器：后台常驻 + 热重载，统一管理网关(nodejs)与前端(uni_app)。
//
// 兼容 Windows / macOS / Linux：用 Node child_process 的 detached + unref 让子进程
// 脱离当前终端独立存活（等价于 setsid/nohup，但三平台通用）；终止时 Windows 用
// taskkill、其它平台按进程组用 kill。pid 与日志统一放在 <apps>/logs 下。
//
// 用法（任意位置运行本脚本即可，它会自动向上找到 apps 目录）：
//   node scripts/dev-server.mjs                 # 等同 start（启动全部）
//   node scripts/dev-server.mjs start           # 启动全部（热重载）
//   node scripts/dev-server.mjs stop            # 停止全部
//   node scripts/dev-server.mjs restart         # 重启全部
//   node scripts/dev-server.mjs status          # 查看各服务是否在跑
//   node scripts/dev-server.mjs log             # 打印各服务日志尾部
//   node scripts/dev-server.mjs start uniapp    # 只启动某个服务（gateway / uniapp）
//
// 说明：uni_app 用 H5 模式做浏览器开发预览；原生 App 部署走 HBuilderX「运行到手机或模拟器」。
// 日志与 pid 文件都在 apps/logs 下，已被 .gitignore 忽略，不会入库。

import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  openSync,
  mkdirSync,
} from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 向上查找同时含 gateway 与 uni_app 子目录的「apps 目录」——无论它叫 apps 还是
 *  xiaoxiong-app、也不管本脚本被放在仓库何处都能定位；找不到则回退为脚本所在目录的父目录。 */
function findAppsDir() {
  let dir = __dirname
  while (true) {
    if (existsSync(join(dir, 'gateway')) && existsSync(join(dir, 'uni_app'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break // 走到文件系统根
    dir = parent
  }
  return dirname(__dirname)
}

const appsDir = findAppsDir()
const logsDir = join(appsDir, 'logs')

/** 网关端口：与后端 server.ts 的 PORT 保持一致（默认 8787）。前后端共用这一个来源，
 * 避免前端把 8787 写死、后端改了 PORT 前端跟不上。 */
function gatewayPort() {
  return Number(process.env.PORT ?? 8787)
}

/** 前端 H5 开发端口：与 uni_app 的 vite dev 端口一致（默认 5173）。 */
function h5Port() {
  return Number(process.env.UNI_APP_DEV_PORT ?? 5173)
}

/** RSA 密钥存放路径：打包/dev 时随机生成一次后复用，确保前后端用的是同一套密钥，
 * 避免「前后端配置不一致」导致加解密失败。已被 .gitignore 忽略。 */
const rsaKeysPath = join(appsDir, '.rsa-keys.json')

/** 生成（或读取已生成的）两套 RSA-2048 密钥：前端一对 + 后端一对。
 * 前后端模型是「各持自己私钥 + 对方公钥」，因此必须来自同一份生成结果，不能各生各的。 */
function ensureRsaKeys() {
  if (existsSync(rsaKeysPath)) {
    try {
      return JSON.parse(readFileSync(rsaKeysPath, 'utf8'))
    } catch {
      // 文件损坏则重新生成
    }
  }
  const gen = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
  const frontend = gen()
  const backend = gen()
  const out = {
    frontendPublic: frontend.publicKey,
    frontendPrivate: frontend.privateKey,
    backendPublic: backend.publicKey,
    backendPrivate: backend.privateKey,
  }
  writeFileSync(rsaKeysPath, JSON.stringify(out, null, 2))
  return out
}

/** 受管服务清单：新增服务只需在这里加一项；cwd 用 appsDir 拼接，天然适配目录改名。 */
const services = [
  {
    key: 'gateway',
    name: '网关',
    cwd: join(appsDir, 'gateway'),
    script: 'dev', // tsx watch，热重载
  },
  {
    key: 'uniapp',
    name: '前端',
    cwd: join(appsDir, 'uni_app'),
    script: 'dev:h5', // 浏览器开发预览（H5）；原生 App 走 HBuilderX「运行到手机或模拟器」
  },
]

const isWin = process.platform === 'win32'
const npmBin = isWin ? 'npm.cmd' : 'npm'
const pidPath = (s) => join(logsDir, `.dev-${s.key}.pid`)
const logPath = (s) => join(logsDir, `dev-${s.key}.log`)

/** 进程是否存在：signal 0 只探测、不发送真实信号。Windows 上无权限也可能抛 EPERM，算存在。 */
function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readPid(s) {
  const p = pidPath(s)
  if (!existsSync(p)) return null
  const n = Number(readFileSync(p, 'utf8').trim())
  return Number.isFinite(n) ? n : null
}

function startOne(s) {
  const existing = readPid(s)
  const already = !!(existing && isAlive(existing))
  let pid
  if (already) {
    pid = existing
  } else {
    mkdirSync(logsDir, { recursive: true }) // 确保日志目录存在，避免 ENOENT
    const file = logPath(s)
    appendFileSync(file, `\n=== start @ ${new Date().toISOString()} ===\n`)
    // 同步开 fd 再传入 stdio，避免 WriteStream 异步打开时 fd 为 null 导致 spawn 失败
    const fd = openSync(file, 'a')
    // detached + unref：子进程进入独立会话/进程组，脱离当前终端，父进程退出后继续存活。
    // 统一来源：网关地址 + RSA 加解密密钥都由 dev 脚本注入，前后端用同一套、避免配置不一致。
    const childEnv = { ...process.env }
    const keys = ensureRsaKeys()
    if (s.key === 'gateway') {
      if (!childEnv.RSA_BACKEND_PRIVATE_KEY) childEnv.RSA_BACKEND_PRIVATE_KEY = keys.backendPrivate
      if (!childEnv.RSA_FRONTEND_PUBLIC_KEY) childEnv.RSA_FRONTEND_PUBLIC_KEY = keys.frontendPublic
    } else if (s.key === 'uniapp') {
      if (!childEnv.VITE_GATEWAY_WS_URL) childEnv.VITE_GATEWAY_WS_URL = `ws://127.0.0.1:${gatewayPort()}/ws`
      if (!childEnv.VITE_RSA_FRONTEND_PRIVATE_KEY) childEnv.VITE_RSA_FRONTEND_PRIVATE_KEY = keys.frontendPrivate
      if (!childEnv.VITE_RSA_BACKEND_PUBLIC_KEY) childEnv.VITE_RSA_BACKEND_PUBLIC_KEY = keys.backendPublic
    }
    const child = spawn(npmBin, ['run', s.script], {
      cwd: s.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: childEnv,
      windowsHide: true,
    })
    child.unref()
    writeFileSync(pidPath(s), String(child.pid))
    pid = child.pid
  }
  // 紧凑输出：一行服务信息 + 一行日志路径，避免刷屏
  const port = s.key === 'gateway' ? gatewayPort() : h5Port()
  const state = already ? '已运行 ' : '已启动'
  let info = `  ✓ ${s.name}  ${state}  pid=${pid}  ·  访问 http://localhost:${port}`
  if (s.key === 'gateway') info += '  ·  Swagger: /doc.html'
  console.log(info)
  console.log(`    日志: ${logPath(s)}`)
}

function stopOne(s) {
  const pid = readPid(s)
  if (!pid || !isAlive(pid)) {
    if (existsSync(pidPath(s))) unlinkSync(pidPath(s))
    console.log(`${s.name} 未在运行。`)
    return false
  }
  if (isWin) {
    // taskkill /t 连带杀掉 npm 拉起的 tsx/vite 子进程树
    spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    // detached 让子进程成为新进程组 leader，pid 即 pgid，-pid 终止整组（npm + 子进程）
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* 已退出 */
      }
    }
  }
  setTimeout(() => {
    if (existsSync(pidPath(s))) unlinkSync(pidPath(s))
  }, 800)
  console.log(`${s.name} 已发送停止信号 (pid=${pid})。`)
  return true
}

function statusOne(s) {
  const pid = readPid(s)
  console.log(`${s.name}：${pid && isAlive(pid) ? `运行中 (pid=${pid})` : '未运行'}`)
}

function logOne(s, tailLines = 60) {
  const file = logPath(s)
  console.log(`\n========== ${s.name} 日志 (${file}) ==========`)
  if (!existsSync(file)) {
    console.log('（暂无日志）')
    return
  }
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  console.log(lines.slice(-tailLines).join('\n'))
}

const arg = process.argv[2] ?? 'start'
const only = process.argv[3] // 可选服务名：gateway / uniapp
const targets = only ? services.filter((s) => s.key === only) : services
if (only && targets.length === 0) {
  console.error(`未知服务：${only}（可选 ${services.map((s) => s.key).join(' / ')}）`)
  process.exit(1)
}

switch (arg) {
  case 'start':
    targets.forEach(startOne)
    break
  case 'stop':
    targets.forEach(stopOne)
    break
  case 'restart':
    // 先停（未在跑则空跑），再启动，保证无论当前是否在跑都能拉起最新代码
    targets.forEach((s) => {
      stopOne(s)
      setTimeout(() => startOne(s), 900)
    })
    break
  case 'status':
    targets.forEach(statusOne)
    break
  case 'log':
    targets.forEach((s) => logOne(s))
    break
  default:
    console.error(
      `未知命令：${arg}（支持 start / stop / restart / status / log，末尾可加服务名 gateway / uniapp）`
    )
    process.exit(1)
}
