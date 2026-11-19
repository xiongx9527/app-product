// 移动端（Android / iOS 内嵌）网关入口。
//
// 由原生层经 nodejs-mobile 启动：iOS 调 `node_start(argc, argv)`、Android 调 `node::Start(argc, argv)`，
// 本文件作为 argv[1] 传入。职责：
//   1. 起网关（httpServer.listen，端口取 GATEWAY_PORT，默认 0 → 系统分配）；
//   2. 等待 'listening' 后，把实际端口写回 GATEWAY_PORT_FILE（默认 <GATEWAY_HOME>/.gateway_port），
//      供原生层读取并注入客户端 `ws://127.0.0.1:<port>`；
//   3. 不主动退出——nodejs-mobile 在 node::Start / node_start 内阻塞事件循环，进程/线程常驻。
//
// 环境（GATEWAY_HOME / GATEWAY_MODE / DOCS_ENABLED / GATEWAY_PORT / GATEWAY_PORT_FILE 等）
// 由原生层在启动前 setenv，server.ts 已据此配置（见 server.ts 的 listen 分支）。
import { createGateway } from '../server'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { startIosDevTunnel } from './iosDevTunnel'

// iOS dev-only USB 隧道开关，由 build.sh 在 [2/3] 经 esbuild `--define` 注入：
//   dev 构建 = true（在设备 127.0.0.1:9529 起 mux 端点，经 USB 转 Mac 语音代理）；
//   test/pro = false（整段代码被常量折叠 + tree-shake，不进 bundle）。
// 单独 `npm run build:bundle`（不经 build.sh）时该全局未定义 → typeof 守卫短路，不启用。
declare const XIAOXIONG_IOS_DEV_TUNNEL: boolean | undefined

// 单条会话的异步异常（如模型构造失败、上游抖动）不应拖垮整个网关：
// 记录后继续运行，让其它会话不受影响，避免助手「老老挂掉」。
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] unhandledRejection (isolated, server kept alive):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[gateway] uncaughtException (kept alive):', err)
})

const gateway = createGateway()
const server = gateway.httpServer

// dev-only：在网关上游地址(127.0.0.1:9529)起 mux 端点，等 Mac helper 经 USB 连入转发。
// 隧道失败只告警，绝不拖垮网关主进程（8787 服务照常）。
if (typeof XIAOXIONG_IOS_DEV_TUNNEL !== 'undefined' && XIAOXIONG_IOS_DEV_TUNNEL) {
  try {
    startIosDevTunnel(gateway.config.voiceBuiltinUrl)
  } catch (err) {
    console.error('[gateway] iosDevTunnel 启动失败(网关继续):', err)
  }
}

server.once('listening', () => {
  const addr = server.address()
  const port =
    typeof addr === 'string'
      ? Number(addr.split(':').pop())
      : (addr as { port: number }).port
  // 仅在嵌入式模式写端口文件：原生层据此注入客户端 ws URL；桌面模式不落 stray 文件。
  if (process.env.GATEWAY_MODE === 'embedded') {
    const portFile =
      process.env.GATEWAY_PORT_FILE ??
      path.join(process.env.GATEWAY_HOME ?? process.cwd(), '.gateway_port')
    writeFileSync(portFile, String(port), { mode: 0o600 })
  }
  console.log(`[gateway] ready on :${port} (ws ${gateway.config.ws.path}, docs /docs)`)
})

// 复用 server.ts 的 listen 分支（内嵌模式只绑回环）；它在 httpServer 上触发 'listening'。
gateway.listen()
