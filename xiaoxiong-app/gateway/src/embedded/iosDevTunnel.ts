/**
 * iOS dev-only 隧道：把设备上发往 `127.0.0.1:9529` 的流量经 USB 转到开发 Mac 的语音代理。
 *
 * 背景：iOS 内嵌网关默认上游是 `http://127.0.0.1:9529`（Mac 上的语音代理），但在设备上
 * `127.0.0.1:9529` 是设备自己，连不到 Mac → health 全红。Android 靠 `adb reverse tcp:9529`
 * 解决，iOS 没有等价物。本模块在设备侧监听同一个回环端口，作为 mux 端点；Mac 侧 helper
 * 用 PeerTalk（`PTUSBHub connectToDevice:toPort:`）经 USB 连进来，按 connId 把每条连接
 * 转到 Mac 的 127.0.0.1:9529。配置里的地址一个字不改，对上层 fetch/SDK 完全透明。
 *
 * 只由 build.sh 在 dev 构建注入 `--define:XIAOXIONG_IOS_DEV_TUNNEL=true` 时启用；test/pro
 * bundle 里这段被 esbuild 常量折叠掉（grep 哨兵 `[ios-dev-tunnel]` 为零）。
 *
 * 帧协议（字节流 mux，单条 mux 通道承载多条逻辑连接）：
 *   8 字节头 = [u32 BE connId][u32 BE len]，紧接 len 字节 payload。
 *   connId=0 保留给控制帧：payload 首字节 'C' + 4 字节 BE connId 表示对端关闭该连接。
 *   mux 通道建立后由 Mac 先写握手行 'XIAOXIONG-PTTUNNEL/1\n'；本端 accept 后缓冲首段，
 *   命中握手即认作 mux 通道（只允许一条），否则按网关自身 HTTP 请求处理并分配 connId。
 */
import net from 'node:net'

const SENTINEL = '[ios-dev-tunnel]'
const HANDSHAKE = 'XIAOXIONG-PTTUNNEL/1'
const HEADER_BYTES = 8
const MAX_FRAME = 1024 * 1024

interface MuxConn {
  socket: net.Socket
  buf: Buffer
}

function frame(connId: number, payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(HEADER_BYTES)
  head.writeUInt32BE(connId, 0)
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

function closeFrame(connId: number): Buffer {
  const payload = Buffer.allocUnsafe(5)
  payload.write('C', 0, 'ascii')
  payload.writeUInt32BE(connId, 1)
  return frame(0, payload)
}

/**
 * 启动 dev 隧道。返回是否真正监听（host 非回环或解析失败则不启用）。
 * dev 隔离由调用方 entry.ts 的 XIAOXIONG_IOS_DEV_TUNNEL 守卫负责；本函数不自行判断构建标志。
 */
export function startIosDevTunnel(voiceBuiltinUrl: string): boolean {
  let host: string
  let port: number
  try {
    const u = new URL(voiceBuiltinUrl)
    host = u.hostname
    port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  } catch {
    console.warn(`${SENTINEL} voiceBuiltinUrl 解析失败，隧道未启用: ${voiceBuiltinUrl}`)
    return false
  }
  // 只对回环上游启用；配到远端地址说明用户主动改了配置，隧道不该插手。
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(`${SENTINEL} 上游非回环(${host})，隧道未启用`)
    return false
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(`${SENTINEL} 上游端口非法(${port})，隧道未启用`)
    return false
  }

  let mux: MuxConn | null = null
  const conns = new Map<number, net.Socket>()
  let nextId = 1

  const dropMux = () => {
    if (mux) {
      console.warn(`${SENTINEL} mux 通道断开，清理 ${conns.size} 条逻辑连接`)
      for (const s of conns.values()) s.destroy()
      conns.clear()
      mux = null
    }
  }

  const server = net.createServer((client) => {
    // 首段缓冲：判断是握手（Mac mux）还是网关自身 HTTP 请求。
    let pending: Buffer | null = null
    let decided = false

    const decide = (first: Buffer) => {
      if (decided) return
      decided = true
      const head = first.subarray(0, Math.max(0, first.indexOf(0x0a) + 1))
      if (head.toString('utf8').trim() === HANDSHAKE) {
        // Mac helper 连入：剩下的字节若还有，按 mux 帧喂给解析器。
        if (mux) {
          console.warn(`${SENTINEL} 重复 mux 连入，关闭旧通道`)
          dropMux()
        }
        mux = { socket: client, buf: Buffer.alloc(0) }
        client.on('data', (d) => feedMux(mux!, d))
        client.on('close', dropMux)
        client.on('error', (e) => {
          console.warn(`${SENTINEL} mux 错误: ${e.message}`)
          dropMux()
        })
        const rest = first.subarray(head.length)
        if (rest.length) feedMux(mux, rest)
        console.log(`${SENTINEL} mux 通道已建立 → 转发 ${host}:${port}`)
        return
      }
      // 网关自身请求：分配 connId，发给 mux，后续字节全部转帧。
      if (!mux) {
        console.warn(`${SENTINEL} 无活动 mux，拒绝连接（Mac helper 未启动？）`)
        client.destroy()
        return
      }
      const id = nextId++
      if (nextId === 0xffffffff) nextId = 1
      conns.set(id, client)
      mux.socket.write(frame(id, first))
      client.on('data', (d) => {
        if (mux) mux.socket.write(frame(id, d))
      })
      const cleanup = () => {
        if (!conns.has(id)) return
        conns.delete(id)
        if (mux && !mux.socket.destroyed) mux.socket.write(closeFrame(id))
      }
      client.on('close', cleanup)
      client.on('error', () => client.destroy())
    }

    client.on('data', (chunk) => {
      if (!decided) {
        pending = pending ? Buffer.concat([pending, chunk]) : chunk
        // 等到出现换行（握手行或 HTTP 请求行）再做判断；首段还没到齐就继续攒。
        if (pending.indexOf(0x0a) >= 0) decide(pending)
        return
      }
      // decided 后普通数据由 decide() 里注册的 'data' 监听器处理；这里的监听器需移除。
    })

    // 若连接关闭时还没决策（比如探测性的空连接），直接丢弃。
    client.on('close', () => {
      if (!decided) pending = null
    })
  })

  // 绑在网关自身上游地址上；端口被占用（比如隧道重复注入）时不致命，仅告警。
  server.once('error', (e) => {
    console.warn(`${SENTINEL} listen ${host}:${port} 失败: ${e.message}`)
  })
  server.listen(port, host, () => {
    console.log(`${SENTINEL} listening on ${host}:${port} (等待 Mac mux 连入)`)
  })

  // mux 解帧：从累积缓冲里取完整的 8 字节头 + payload。
  function feedMux(m: MuxConn, data: Buffer) {
    m.buf = m.buf.length ? Buffer.concat([m.buf, data]) : data
    while (m.buf.length >= HEADER_BYTES) {
      const id = m.buf.readUInt32BE(0)
      const len = m.buf.readUInt32BE(4)
      if (len > MAX_FRAME) {
        console.warn(`${SENTINEL} 帧过大(${len})，断开 mux`)
        m.socket.destroy()
        dropMux()
        return
      }
      if (m.buf.length < HEADER_BYTES + len) break
      const payload = Buffer.from(m.buf.subarray(HEADER_BYTES, HEADER_BYTES + len))
      m.buf = m.buf.subarray(HEADER_BYTES + len)

      if (id === 0) {
        // 控制帧：关闭指定 connId
        if (payload.length >= 5 && payload[0] === 0x43 /* C */) {
          const target = payload.readUInt32BE(1)
          const s = conns.get(target)
          if (s) {
            conns.delete(target)
            s.destroy()
          }
        }
        continue
      }
      const target = conns.get(id)
      if (target && !target.destroyed) target.write(payload)
      else m.socket.write(closeFrame(id))
    }
  }

  return true
}
