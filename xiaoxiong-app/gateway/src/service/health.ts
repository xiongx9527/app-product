import type { GatewayConfig } from '../config'

/** 单个能力（ASR / LLM / TTS）的就绪状态，供界面直接展示 */
export interface ProviderStatus {
  /** 配置的提供商名（whisper / edge / ollama / stub…） */
  provider: string
  /** 是否真接入了真实引擎（provider !== 'stub'）；false 表示仍是占位桩，功能不可用 */
  configured: boolean
  /** 真实引擎是否真正可用：ASR/TTS 做功能性探测（真发请求验证能识别/合成），
   *  LLM 做连通探测；仅地址可达不代表功能正常。 */
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

// 功能探测结果缓存：避免 /api/health 轮询每次都真打一遍 ASR/TTS 给真实服务加压。
// 同地址 15s 内复用，仍能及时反映服务上下线。
const probeCache = new Map<string, { ok: boolean; at: number }>()
const PROBE_TTL_MS = 15000
async function cachedProbe(key: string, fn: () => Promise<boolean>): Promise<boolean> {
  const cached = probeCache.get(key)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok
  const ok = await fn()
  probeCache.set(key, { ok, at: Date.now() })
  return ok
}

/** 仅供测试：清掉功能性探测缓存，避免用例间串味。 */
export function clearProbeCache(): void {
  probeCache.clear()
}

/** 极短静音 WAV（16k/16bit/单声道），仅用于探测 ASR 是否真能接收并解析音频。 */
function tinySilentWav(): Uint8Array {
  const sampleRate = 16000
  const pcm = new Int16Array(1600) // 0.1s 静音
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.byteLength, 40)
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm.buffer)]))
}

/**
 * 功能性探测 ASR：真发一段音频到 /v1/audio/transcriptions，能回合法 JSON 才算通。
 * 只 ping baseUrl 会误判——坏掉的上游代理也能回 200，但真正转写会 5xx/超时；
 * 之前「对不了话」正是本机 127.0.0.1:9529 的语音服务挂了却被报成 reachable=true。
 */
async function probeAsr(baseUrl: string): Promise<boolean> {
  return cachedProbe(`asr:${baseUrl}`, async () => {
    try {
      const form = new FormData()
      form.append('file', new Blob([tinySilentWav()], { type: 'audio/wav' }), 'probe.wav')
      form.append('model', 'whisper-1')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        })
        if (!res.ok) return false
        const parsed = JSON.parse(await res.text()) as unknown
        return parsed !== null && typeof parsed === 'object'
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  })
}

/** 功能性探测 TTS：真发一句文本到 /v1/audio/speech，能回非空音频才算通。 */
async function probeTts(baseUrl: string): Promise<boolean> {
  return cachedProbe(`tts:${baseUrl}`, async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: '你好',
            voice: 'zh-CN-XiaoxiaoNeural',
            response_format: 'wav',
          }),
          signal: controller.signal,
        })
        if (!res.ok) return false
        const ab = new Uint8Array(await res.arrayBuffer())
        return ab.length > 44 // 至少含 WAV 头
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  })
}

async function buildStatus(
  provider: string,
  baseUrl: string,
  kind: 'asr' | 'tts' | 'llm',
): Promise<ProviderStatus> {
  if (provider === 'stub') return summarizeProvider('stub', false)
  const endpoint = hostOf(baseUrl)
  const reachable =
    kind === 'asr'
      ? await probeAsr(baseUrl)
      : kind === 'tts'
        ? await probeTts(baseUrl)
        : await probe(baseUrl)
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

/** 汇总 LLM / ASR / TTS 三类能力的就绪状态，供 /api/health 返回。
 *  ASR/TTS 用功能性探测（真发请求验证），LLM 沿用轻量连通探测。 */
export async function buildHealth(config: GatewayConfig): Promise<HealthReport> {
  const [asr, llm, tts, network] = await Promise.all([
    buildStatus(config.asr.provider, config.asr.baseUrl, 'asr'),
    buildStatus(config.llm.provider, config.llm.baseUrl, 'llm'),
    buildStatus(config.tts.provider, config.tts.baseUrl, 'tts'),
    probeExternal(),
  ])
  return { asr, llm, tts, network }
}
