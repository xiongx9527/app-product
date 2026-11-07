#!/usr/bin/env node
// 跨平台开发服务器管理器：后台常驻 + 热重载，统一管理网关(nodejs)与前端(uni_app)。
//
// 兼容 Windows / macOS / Linux：用 Node child_process 的 detached + unref 让子进程
// 脱离当前终端独立存活（等价于 setsid/nohup，但三平台通用）；终止时 Windows 用
// taskkill、其它平台按进程组用 kill，pid 与日志分别记录在各服务目录。
//
// 用法（在 apps/gateway 目录下，或任意位置用绝对/相对路径调用本脚本）：
//   node scripts/dev-server.mjs                 # 等同 start（启动全部）
//   node scripts/dev-server.mjs start           # 启动全部（热重载）
//   node scripts/dev-server.mjs stop            # 停止全部
//   node scripts/dev-server.mjs restart         # 重启全部
//   node scripts/dev-server.mjs status          # 查看各服务是否在跑
//   node scripts/dev-server.mjs log             # 打印各服务日志尾部
//   node scripts/dev-server.mjs start uniapp    # 只启动某个服务（gateway / uniapp）
//   node scripts/dev-server.mjs log gateway     # 只看某个服务日志
//
// 说明：uni_app 默认用 dev:h5（Vite，跨平台可跑、HMR）；真机 App 仍走 HBuilderX。

import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  openSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 脚本位于 apps/gateway/scripts/，向上三级到仓库根
const repoRoot = join(__dirname, '..', '..', '..')

/** 受管服务清单：新增服务只需在这里加一项 */
const services = [
  {
    key: 'gateway',
    name: '网关 (gateway / nodejs)',
    cwd: join(repoRoot, 'apps', 'gateway'),
    script: 'dev', // tsx watch，热重载
  },
  {
    key: 'uniapp',
    name: '前端 (uni_app)',
    cwd: join(repoRoot, 'apps', 'uni_app'),
    script: 'dev:h5', // uni + Vite，HMR 热更新；真机 App 仍需 HBuilderX
  },
]

const isWin = process.platform === 'win32'
const npmBin = isWin ? 'npm.cmd' : 'npm'
const pidPath = (s) => join(s.cwd, `.dev-${s.key}.pid`)
const logPath = (s) => join(s.cwd, `dev-${s.key}.log`)

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
  if (existing && isAlive(existing)) {
    console.log(`${s.name} 已在运行 (pid=${existing})，无需重复启动。日志：${logPath(s)}`)
    return
  }
  const file = logPath(s)
  appendFileSync(file, `\n=== start @ ${new Date().toISOString()} ===\n`)
  // 同步开 fd 再传入 stdio，避免 WriteStream 异步打开时 fd 为 null 导致 spawn 失败
  const fd = openSync(file, 'a')
  // detached + unref：子进程进入独立会话/进程组，脱离当前终端，父进程退出后继续存活。
  // 这正是 setsid/nohup 在三个平台上统一替代方案。
  const child = spawn(npmBin, ['run', s.script], {
    cwd: s.cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
    windowsHide: true,
  })
  child.unref()
  writeFileSync(pidPath(s), String(child.pid))
  console.log(`${s.name} 已后台启动（热重载），pid=${child.pid}`)
  console.log(`  日志：${file}`)
  console.log(`  停止：node scripts/dev-server.mjs stop ${s.key}`)
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
  const slice = lines.slice(-tailLines)
  console.log(slice.join('\n'))
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
