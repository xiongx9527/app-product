import { onUnmounted, ref, watch, type Ref } from 'vue'
import { resolveGatewayHttpBase } from '@/core/transport'
import { activeVoiceConfig } from '@/core/config'

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
function httpGetJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof uni !== 'undefined' && typeof uni.request === 'function') {
      uni.request({
        url,
        method: 'GET',
        header: { accept: 'application/json', ...headers },
        success: (res) => resolve(res.data),
        fail: (err) => reject(err),
      })
      return
    }
    if (typeof fetch !== 'undefined') {
      fetch(url, { cache: 'no-store', headers })
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
      // 把当前选中的语音来源配置带给网关，使其按所选来源（如 DashScope）探测能力，
      // 而非永远探测网关默认的内置；密钥只在本机 localhost 回传网关、响应不含密钥。
      const voice = activeVoiceConfig()
      const data = (await httpGetJson(`${base}${HEALTH_PATH}`, {
        'x-voice-config': JSON.stringify(voice),
      })) as {
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

/**
 * 手动触发一次能力检测：按指定语音来源配置探测 LLM / ASR / TTS / 外网是否正常。
 * 与定时轮询共用同一套响应解析，只是这里由设置页「一键检测」按钮主动触发，
 * 不依赖 WS 是否连上。返回 HealthReport；网关不可达或响应异常时返回 null。
 * @param voice 客户端当前选中的语音来源配置（含 url / apiKey / model / voice），不传则回退网关默认
 * @param deep 是否做深度探测：true 时 LLM 会真正发一次最小对话补全，
 *   能暴露「连通但不可用」的故障（欠费 / 模型名不存在 / 密钥无权限），而非误报正常
 */
export async function fetchHealthReport(voice: unknown, deep = false): Promise<HealthReport | null> {
  try {
    const base = resolveGatewayHttpBase()
    // 把当前选中的语音来源配置带给网关，使其按所选来源（如 DashScope）探测能力，
    // 而非永远探测网关默认的内置；密钥只在本机 localhost 回传网关、响应不含密钥。
    const data = (await httpGetJson(`${base}${HEALTH_PATH}?${deep ? 'deep=1' : ''}`, {
      'x-voice-config': JSON.stringify(voice),
    })) as { providers?: HealthReport }
    if (!data?.providers) return null
    return data.providers
  } catch {
    return null
  }
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
