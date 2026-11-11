import type { GatewayConfig } from '../config'
import { resolveCapabilityConfig } from '../voiceConfig'
import type { VoiceConfig } from '../voiceConfig'
import { DashScopeWsTts } from '../tts/dashscopeWs'

/** 单个能力（ASR / LLM / TTS）的就绪状态，供界面直接展示 */
export interface ProviderStatus {
  /** 配置的提供商名（builtin / dashscope / stub…） */
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

async function probeOne(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

/**
 * 主机连通性：能收到任何 HTTP 响应（含 4xx/5xx）即视为主机可达；仅网络错误/超时算不可达。
 * 用于 WebSocket 类能力（DashScope ASR/TTS）的轻量可达性判断——无法在此做功能性 HTTP 探测。
 */
async function probeHost(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await fetch(baseUrl.replace(/\/$/, ''), { method: 'GET', signal: controller.signal })
      return true
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

async function probe(baseUrl: string, apiKey?: string, timeoutMs = 3000): Promise<boolean> {
  const headers: Record<string, string> = {}
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  if (await probeOne(baseUrl, timeoutMs, headers)) return true
  const base = baseUrl.replace(/\/$/, '')
  for (const p of HEALTH_FALLBACK_PATHS) {
    if (await probeOne(`${base}${p}`, Math.min(timeoutMs, 1500), headers)) return true
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
 * DashScope ASR 是 WebSocket（wss://host/api-ws/v1/inference），无功能性 HTTP 接口，
 * 退化为「已配密钥 + 主机可达」的近似判断（无法在此做真转写探测）。
 */
async function probeAsr(baseUrl: string, provider: string, apiKey?: string): Promise<boolean> {
  if (provider === 'dashscope') {
    if (!apiKey) return false
    return probeHost(baseUrl)
  }
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

/** 功能性探测 TTS：真发一句文本到 /v1/audio/speech，能回非空音频才算通。
 *  DashScope TTS 是 WebSocket：
 *  - deep（一键检测）时真跑一次合成（DashScopeWsTts.probe），收到真实音频帧才算可用，
 *    云端错误（如 418 音色/模型不匹配）原样带回界面——不再「主机通就报绿」；
 *  - 普通轮询（deep=false）避免每 30s 都打一次 WS 合成烧额度，退化为「已配密钥 + 主机可达」判断。 */
async function probeTts(
  baseUrl: string,
  provider: string,
  apiKey: string | undefined,
  endpoint: string,
  deep: boolean,
): Promise<ProviderStatus> {
  if (provider === 'dashscope') {
    if (!apiKey) {
      return {
        provider,
        configured: true,
        reachable: false,
        endpoint,
        message: '已配置但缺少 api-key，无法合成',
      }
    }
    if (!deep) {
      // 轻量轮询：只确认主机可达，不真合成（省额度）。
      const up = await probeHost(baseUrl)
      return {
        provider,
        configured: true,
        reachable: up,
        endpoint,
        message: up
          ? `已配置（${endpoint}）；点「一键检测」可验证真实合成`
          : `已配置但地址不可达（${endpoint}）`,
      }
    }
    // 真实合成探测：用默认模型（cosyvoice-v3-flash）跑一句，结果反映真实可用性。
    const tts = new DashScopeWsTts(baseUrl, {}, apiKey)
    const result = await tts.probe()
    return {
      provider,
      configured: true,
      reachable: result.ok,
      endpoint,
      message: result.ok ? `已接入（真实合成成功，${endpoint}）` : result.message,
    }
  }
  const ok = await cachedProbe(`tts:${baseUrl}`, async () => {
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
  return summarizeProvider(provider, ok, endpoint)
}

async function buildStatus(
  provider: string,
  baseUrl: string,
  kind: 'asr' | 'tts' | 'llm',
  apiKey: string | undefined,
  deep: boolean,
): Promise<ProviderStatus> {
  if (provider === 'stub') return summarizeProvider('stub', false)
  const endpoint = hostOf(baseUrl)
  // TTS 直接返回 ProviderStatus（deep 时走真实合成探测，需带上具体失败原因）；
  // ASR / LLM 仍是布尔可达性，由 summarizeProvider 收敛成状态。
  if (kind === 'tts') return probeTts(baseUrl, provider, apiKey, endpoint, deep)
  const reachable =
    kind === 'asr' ? await probeAsr(baseUrl, provider, apiKey) : await probe(baseUrl, apiKey)
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
    EXTERNAL_HOSTS.map((h) => probe(h, undefined, 2500)),
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
 *  ASR/TTS 用功能性探测（真发请求验证），LLM 沿用轻量连通探测。
 *  voice 为客户端当前选中的语音来源配置：不传则回退网关默认（内置），
 *  传了（如 DashScope）就按所选来源展开并探测——这样面板反映用户实际会用的那套能力。 */
/**
 * 功能性探测 LLM：真发一次最小对话补全（max_tokens=1），能回 2xx 才算通。
 * 连通探测（只 GET 根路径）会漏掉「地址通、但调模型被拒」这类故障——典型如欠费 / 额度不足 /
 * 模型名不存在 / 密钥无权限：端点照样可达，真正对话才炸。deep 检测（一键检测按钮）走这条，
 * 把上游真实报错（如「余额不足」）带回到界面，而不是误报「正常」。
 * 未选模型（model 为空）时无法真正调用，退化为连通探测并在 message 里说清原因。
 */
async function probeLlmDeep(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  timeoutMs = 8000,
): Promise<ProviderStatus> {
  const endpoint = hostOf(baseUrl)
  if (!model) {
    // 没选模型，没法真正调用对话接口：绝不能报“可用”（假绿），只能说明“无法验证”。
    // 仍顺手探一下主机连通性用于更具体的提示，但 reachable 一律为 false。
    const hostUp = await probe(baseUrl, apiKey)
    return {
      provider: 'llm',
      configured: true,
      reachable: false,
      endpoint,
      message: hostUp
        ? `主机可达（${endpoint}），但未选择模型，无法验证对话能力`
        : `未选择模型，且地址不可达（${endpoint}）`,
    }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (res.ok) {
        return { provider: 'llm', configured: true, reachable: true, endpoint, message: `已接入（${endpoint}）` }
      }
      const text = await res.text().catch(() => '')
      return {
        provider: 'llm',
        configured: true,
        reachable: false,
        endpoint,
        message: `已配置但调用失败（${endpoint}）：${res.status} ${text.slice(0, 200)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return {
      provider: 'llm',
      configured: true,
      reachable: false,
      endpoint,
      message: `已配置但调用失败（${endpoint}）：${(e as Error).message}`,
    }
  }
}

export async function buildHealth(
  config: GatewayConfig,
  voice?: VoiceConfig,
  deep = false,
): Promise<HealthReport> {
  const resolved = resolveCapabilityConfig(voice, config)
  const asr = await buildStatus(resolved.asr.provider, resolved.asr.baseUrl, 'asr', resolved.asr.apiKey, deep)
  const tts = await buildStatus(resolved.tts.provider, resolved.tts.baseUrl, 'tts', resolved.tts.apiKey, deep)
  const network = await probeExternal()
  // LLM：deep（一键检测）走真正调用模型，能暴露欠费 / 模型名 / 密钥这类「连通但不可用」故障；
  // 其余（30s 轮询）只做连通探测，避免每次轮询都真打模型烧额度。
  const llm = deep
    ? await probeLlmDeep(resolved.llm.baseUrl, resolved.llm.apiKey, resolved.llm.model)
    : await buildStatus(resolved.llm.provider, resolved.llm.baseUrl, 'llm', resolved.llm.apiKey, deep)
  return { asr, llm, tts, network }
}
