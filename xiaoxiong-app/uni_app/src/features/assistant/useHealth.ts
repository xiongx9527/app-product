import { onUnmounted, ref, watch, type Ref } from 'vue'
import { resolveGatewayHttpBase } from '@/core/transport'

/** 单个能力（ASR / LLM / TTS）的就绪状态，与网关 /api/health 返回对齐 */
interface ProviderStatus {
  provider: string
  configured: boolean
  reachable: boolean
  message: string
  endpoint?: string
}

/** 外网连通性状态 */
interface NetworkStatus {
  reachable: boolean
  message: string
  host?: string
}

interface HealthReport {
  asr: ProviderStatus
  llm: ProviderStatus
  tts: ProviderStatus
  network: NetworkStatus
}

export type HealthStatus = 'ok' | 'warn' | 'down'

export interface HealthItem {
  key: 'llm' | 'asr' | 'tts' | 'network'
  status: HealthStatus
  detail: string
}

const HEALTH_PATH = '/api/health'
/** 定时检测 LLM / ASR / TTS / 外网的间隔；仅在建连（WS 已连）时轮询，断开即停。 */
const POLL_MS = 30000

/** 跨端发 GET 并解析 JSON：App 走 uni.request，H5 / 测试环境回退 fetch */
function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof uni !== 'undefined' && typeof uni.request === 'function') {
      uni.request({
        url,
        method: 'GET',
        header: { accept: 'application/json' },
        success: (res) => resolve(res.data),
        fail: (err) => reject(err),
      })
      return
    }
    if (typeof fetch !== 'undefined') {
      fetch(url, { cache: 'no-store' })
        .then((r) => r.json())
        .then(resolve)
        .catch(reject)
      return
    }
    reject(new Error('no http client available'))
  })
}

/**
 * 网关能力健康度：连上 WS 后轮询 /api/health，把 LLM / ASR / TTS / 外网状态暴露给界面。
 * 静默失效（如 ASR 仍是占位桩）能直接被看到，而不是「唤醒没反应」却毫无提示。
 */
export function useHealth(wsConnected: Ref<boolean>) {
  const health = ref<HealthReport | null>(null)
  const healthError = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function fetchHealth(): Promise<void> {
    try {
      const base = resolveGatewayHttpBase()
      const data = (await httpGetJson(`${base}${HEALTH_PATH}`)) as {
        providers?: HealthReport
      }
      if (!data?.providers) {
        healthError.value = true
        return
      }
      health.value = data.providers
      healthError.value = false
    } catch {
      healthError.value = true
    }
  }

  function start(): void {
    if (timer) return
    void fetchHealth()
    timer = setInterval(() => void fetchHealth(), POLL_MS)
  }

  function reset(): void {
    stopTimer()
    health.value = null
    healthError.value = false
  }

  watch(
    wsConnected,
    (connected) => {
      if (connected) start()
      else reset()
    },
    { immediate: true },
  )

  onUnmounted(stopTimer)

  return { health, healthError, refreshHealth: fetchHealth }
}

/** 把 /api/health 的 providers 收敛成界面要展示的状态项（纯函数，便于复用） */
export function toHealthItems(report: HealthReport): HealthItem[] {
  const asr: HealthItem = {
    key: 'asr',
    status: !report.asr.configured ? 'warn' : report.asr.reachable ? 'ok' : 'down',
    detail: report.asr.message,
  }
  const llm: HealthItem = {
    key: 'llm',
    status: !report.llm.configured ? 'warn' : report.llm.reachable ? 'ok' : 'down',
    detail: report.llm.message,
  }
  const tts: HealthItem = {
    key: 'tts',
    status: !report.tts.configured ? 'warn' : report.tts.reachable ? 'ok' : 'down',
    detail: report.tts.message,
  }
  const network: HealthItem = {
    key: 'network',
    status: report.network.reachable ? 'ok' : 'down',
    detail: report.network.message,
  }
  return [llm, asr, tts, network]
}
