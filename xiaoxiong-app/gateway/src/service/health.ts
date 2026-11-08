import type { GatewayConfig } from '../config'

/** 单个能力（ASR / LLM / TTS）的就绪状态，供界面直接展示 */
export interface ProviderStatus {
  /** 配置的提供商名（whisper / edge / ollama / stub…） */
  provider: string
  /** 是否真接入了真实引擎（provider !== 'stub'）；false 表示仍是占位桩，功能不可用 */
  configured: boolean
  /** 最佳努力探测：真实引擎地址是否可达 */
  reachable: boolean
  /** 人类可读状态，界面直接展示 */
  message: string
  /** 真实引擎地址（仅 configured 时带出，便于排查）；stub 时不带 */
  endpoint?: string
}

export interface HealthReport {
  asr: ProviderStatus
  llm: ProviderStatus
  tts: ProviderStatus
  /** 外网连通性：点歌（B 站/百度）、天气等需联网的功能依赖它 */
  network: NetworkStatus
}

/** 外网连通性状态 */
export interface NetworkStatus {
  /** 能否访问外网（任一探测主机可达即视为可达） */
  reachable: boolean
  /** 人类可读状态 */
  message: string
  /** 成功连通的外网主机 host:port（不可达时无） */
  host?: string
}

/** 从地址里抽出 host:port，便于界面展示与排查（不泄漏完整路径） */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 纯函数：把「是否桩 / 是否可达 / 地址」收敛成界面状态。无网络依赖，便于单测。
 * stub 视为未接入——这正是「裸跑成桩、界面却毫无提示」这类静默失效的根因来源。
 */
export function summarizeProvider(
  provider: string,
  reachable: boolean,
  endpoint?: string
): ProviderStatus {
  if (provider === 'stub') {
    return {
      provider,
      configured: false,
      reachable: false,
      message: '未接入真实引擎（占位桩：无法真实识别 / 合成，功能不可用）',
    }
  }
  return {
    provider,
    configured: true,
    reachable,
    endpoint,
    message: reachable ? `已接入（${endpoint}）` : `已配置但地址不可达（${endpoint}）`,
  }
}

/**
 * 最佳努力探测一组候选地址，任一返回 2xx/3xx 即视为可达。
 * 先打 baseUrl 本身；若它 4xx/5xx（很多服务根路径不实现，如 OpenAI 兼容服务的
 * `/v1/models`、Ollama 的 `/api/tags`），再依次试常见健康/能力路径——
 * 否则会出现「服务明明在跑、根路径却 404，被误判为不可用」的反向误报。
 * 只有全部连不上 / 超时，才算真正不可达。
 */
const HEALTH_FALLBACK_PATHS = ['/v1/models', '/health', '/api/tags', '/models', '/v1/health']

async function probeOne(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { method: 'GET', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

async function probe(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  if (await probeOne(baseUrl, timeoutMs)) return true
  const base = baseUrl.replace(/\/$/, '')
  for (const p of HEALTH_FALLBACK_PATHS) {
    if (await probeOne(`${base}${p}`, Math.min(timeoutMs, 1500))) return true
  }
  return false
}

async function buildStatus(provider: string, baseUrl: string): Promise<ProviderStatus> {
  if (provider === 'stub') return summarizeProvider('stub', false)
  const endpoint = hostOf(baseUrl)
  const reachable = await probe(baseUrl)
  return summarizeProvider(provider, reachable, endpoint)
}

/**
 * 外网连通性探测：并行探测几个点歌功能实际依赖的外网源（百度 / B 站），
 * 任一可达即视为外网正常。全部超时/失败才报不可达——用于提前暴露
 * 「点歌、天气等需联网功能会失败」这一类问题，而非等用户点了才发现。
 */
const EXTERNAL_HOSTS = ['https://www.baidu.com', 'https://www.bilibili.com']

async function probeExternal(): Promise<NetworkStatus> {
  const results = await Promise.allSettled(
    EXTERNAL_HOSTS.map((h) => probe(h, 2500)),
  )
  const idx = results.findIndex((r) => r.status === 'fulfilled' && r.value)
  if (idx >= 0) {
    const host = hostOf(EXTERNAL_HOSTS[idx])
    return { reachable: true, message: `外网可达（${host}）`, host }
  }
  return {
    reachable: false,
    message: '外网不可达（点歌 / 天气等需联网的功能将失败）',
  }
}

/** 汇总 LLM / ASR / TTS 三类能力的就绪状态，供 /api/health 返回。 */
export async function buildHealth(config: GatewayConfig): Promise<HealthReport> {
  const [asr, llm, tts, network] = await Promise.all([
    buildStatus(config.asr.provider, config.asr.baseUrl),
    buildStatus(config.llm.provider, config.llm.baseUrl),
    buildStatus(config.tts.provider, config.tts.baseUrl),
    probeExternal(),
  ])
  return { asr, llm, tts, network }
}
