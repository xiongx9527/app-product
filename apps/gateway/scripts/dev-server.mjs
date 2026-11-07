#!/usr/bin/env node
// 跨平台网关开发服务器：后台常驻 + 热重载（tsx watch）。
//
// 设计目标：在 Windows / macOS / Linux 上都能「一键后台启动、热重载、再一键停止」，
// 不依赖 setsid / nohup / tmux 等平台专有命令。原理是用 Node child_process 的
// detached + unref 让子进程脱离当前终端会话独立存活；终止时 Windows 用 taskkill、
// 其它平台按进程组用 kill，统一通过 .dev-server.pid 记录进程号。
//
// 用法（在 apps/gateway 目录下）：
//   node scripts/dev-server.mjs          # 等同 start
//   node scripts/dev-server.mjs start    # 后台启动（tsx watch 热重载）
//   node scripts/dev-server.mjs stop     # 停止
//   node scripts/dev-server.mjs restart  # 重启
//   node scripts/dev-server.mjs status   # 查看是否在跑

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
const root = join(__dirname, '..')
const pidFile = join(root, '.dev-server.pid')
const logFile = join(root, 'dev-server.log')

const isWin = process.platform === 'win32'
const npmBin = isWin ? 'npm.cmd' : 'npm'

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

function readPid() {
  if (!existsSync(pidFile)) return null
  const n = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isFinite(n) ? n : null
}

function start() {
  const existing = readPid()
  if (existing && isAlive(existing)) {
    console.log(`网关已在运行 (pid=${existing})，无需重复启动。日志：${logFile}`)
    return
  }
  appendFileSync(logFile, `\n=== start @ ${new Date().toISOString()} ===\n`)
  // detached + unref：子进程进入独立会话/进程组，脱离当前终端，父进程退出后继续存活。
  // 这正是 setsid/nohup 在三个平台上统一替代方案。
  const child = spawn(npmBin, ['run', 'dev'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env: process.env,
    windowsHide: true,
  })
  child.unref()
  writeFileSync(pidFile, String(child.pid))
  console.log(`网关开发服务器已后台启动（热重载），pid=${child.pid}`)
  console.log(`日志：${logFile}`)
  console.log(`停止：node scripts/dev-server.mjs stop`)
}

function stop() {
  const pid = readPid()
  if (!pid || !isAlive(pid)) {
    console.log('网关未在运行（或 pid 文件缺失）。')
    if (existsSync(pidFile)) unlinkSync(pidFile)
    return
  }
  if (isWin) {
    // taskkill /t 连带杀掉 npm 拉起的 tsx 子进程树
    spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    // detached 让子进程成为新进程组 leader，pid 即 pgid，-pid 终止整组（npm + tsx + node）
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
  // 给退出留一点时间，再清理 pid 文件
  setTimeout(() => {
    if (existsSync(pidFile)) unlinkSync(pidFile)
    console.log(`已发送停止信号 (pid=${pid})。`)
  }, 800)
}

function status() {
  const pid = readPid()
  if (pid && isAlive(pid)) {
    console.log(`网关运行中 (pid=${pid})。日志：${logFile}`)
  } else {
    console.log('网关未运行。')
  }
}

const cmd = process.argv[2] ?? 'start'
switch (cmd) {
  case 'start':
    start()
    break
  case 'stop':
    stop()
    break
  case 'restart':
    stop()
    setTimeout(start, 900)
    break
  case 'status':
    status()
    break
  default:
    console.error(`未知命令：${cmd}（支持 start / stop / restart / status）`)
    process.exit(1)
}
