/**
 * 关键链路诊断日志（长期保留，不因定位完成而删除）。
 *
 * 【为什么异步】旧实现用 appendFileSync 同步写文件，iOS NodeMobile 上播报期高频
 * bargeDiag（FRAME 每 400ms + 每 50 帧 TOTAL + 回执事件）的同步 I/O 会阻塞网关事件循环，
 * 让 WS 回执/tts.idle/health 全部延迟（真机铁证：sendText completion 25s/36s、DATA_STALL）。
 * 改为「内存环形缓冲 + 异步 appendFile 定时落盘」，写入路径零同步 I/O。
 *
 * 【不丢日志】pending 落盘失败会把整块放回队列下次重写；/api/diag/log 从内存 ring 读，
 * 即时可见且零文件 I/O；文件仍异步落盘供长期留存（Android run-as / iOS 沙盒备份）。
 */
import { appendFile, statSync, openSync, readSync, closeSync } from 'node:fs'

const LOG_PATH = (): string => `${process.env.GATEWAY_HOME ?? '.'}/barge-diag.log`

/** 内存保留最近 N 行，供 /api/diag/log 即时读；接口上限 2000 行，留足余量 */
const RING_CAP = 5000
/** 异步落盘周期 */
const FLUSH_MS = 200
/** pending 超过该行数立即触发异步 flush（不等定时） */
const FLUSH_THRESHOLD = 64

const ring: string[] = []
let pending: string[] = []
let flushing = false
let timer: ReturnType<typeof setInterval> | null = null

// 【关键日志·长期保留】事件循环心跳：每 500ms 一条 HB。若 Node 事件循环被同步代码阻塞，
// 心跳 timer 不执行，恢复后第一条用单调时钟算出 gapMs——这是"事件循环卡了多久"的直接证据。
// 卡死期间心跳也不会执行，所以最后一条 HB 的墙钟时刻=卡死起点，配合 gapMs=卡死时长。
const HB_MS = 500
let hbTimer: ReturnType<typeof setInterval> | null = null
let hbSeq = 0
let lastHbMono = 0

// 【关键日志·长期保留】当前阶段标记：业务在关键路径 setDiagStage()，心跳带上它。
// 卡死前最后一条 HB 的 stage 就是阻塞发生的位置，这是定位"事件循环卡在哪段代码"的关键。
let currentStage = 'init'
export function setDiagStage(stage: string): void {
  currentStage = stage
}

function startHeartbeat(): void {
  if (hbTimer) return
  lastHbMono = monotonicMs()
  hbTimer = setInterval(() => {
    const now = monotonicMs()
    const gap = now - lastHbMono
    lastHbMono = now
    hbSeq += 1
    // 正常 tick ≈ HB_MS；gap 明显偏大 = 事件循环被阻塞过（恢复后这条才打出来）
    const mark = gap > HB_MS * 2 ? ` HB-GAP gapMs=${Math.round(gap)}` : ''
    bargeDiag(`HB seq=${hbSeq} stage=${currentStage}${mark}`)
  }, HB_MS)
  if (typeof hbTimer.unref === 'function') hbTimer.unref()
}

/** 单调时钟（毫秒），不受系统时间调整影响 */
function monotonicMs(): number {
  const h = process.hrtime.bigint()
  return Number(h / 1000000n)
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(() => { void flush() }, FLUSH_MS)
  // 不阻止进程退出（NodeMobile / 测试进程都能正常结束）
  if (typeof timer.unref === 'function') timer.unref()
  startHeartbeat()
}

/** 异步把 pending 落到文件；失败整块放回队首，下次重试，绝不丢关键日志 */
function flush(): void {
  if (flushing || pending.length === 0) return
  flushing = true
  const chunk = pending.join('')
  pending = []
  appendFile(LOG_PATH(), chunk, (err) => {
    flushing = false
    if (err) pending.unshift(chunk)
  })
}

/** 写一行诊断日志（零同步 I/O）。行为与旧 bargeDiag 完全一致，调用方无感。 */
export function bargeDiag(line: string): void {
  const row = `${new Date().toISOString()} ${line}\n`
  ring.push(row)
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
  pending.push(row)
  ensureTimer()
  if (pending.length >= FLUSH_THRESHOLD) void flush()
}

/** /api/diag/log 用：优先从内存环形缓冲取（零 I/O）；若 ring 不足（如网关刚重启，
 *  历史心跳还在落盘文件里），只读文件尾部 1MB 补足——这是拿回"卡死前最后心跳"的关键。
 *  只读尾部字节、绝不读整文件，避免同步 I/O 阻塞事件循环。 */
export function readDiagTail(lines: number): string {
  const n = Math.min(2000, Math.max(1, Number.isFinite(lines) ? lines : 300))
  let text = ring.slice(-n).join('')
  const haveLines = ring.length
  if (haveLines < n) {
    try {
      const path = LOG_PATH()
      const size = statSync(path).size
      const readLen = Math.min(size, 1024 * 1024)
      const buf = Buffer.alloc(readLen)
      const fd = openSync(path, 'r')
      try { readSync(fd, buf, 0, readLen, size - readLen) } finally { closeSync(fd) }
      const fileTail = buf.toString('utf8').split('\n').slice(-(n - haveLines + 1)).join('\n')
      text = fileTail + (text ? '\n' + text : '')
    } catch { /* 文件读失败则用内存内容 */ }
  }
  return text
}

// 模块加载即启动心跳，确保网关启动后全程可观测（不等第一次 bargeDiag）
startHeartbeat()
bargeDiag('DIAG-LOG-INIT heartbeat every 500ms')
