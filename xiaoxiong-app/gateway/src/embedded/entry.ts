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
// 由原生层在启动前 setenv，server.ts 已据此配置（见 server.ts 的 CUE_DIR 与 listen 分支）。
import { createGateway } from '../server'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const gateway = createGateway()
const server = gateway.httpServer

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
