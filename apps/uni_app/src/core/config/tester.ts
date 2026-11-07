import type { Capability, ConfigValue, ProviderTemplate } from './types'

export interface TestResult {
  ok: boolean
  message: string
}

interface RawResponse {
  statusCode: number
  data: unknown
}

interface RequestParams {
  url: string
  method?: 'GET' | 'POST'
  header?: Record<string, string>
  data?: Record<string, unknown>
  timeout?: number
  responseType?: 'text' | 'arraybuffer'
}

function joinUrl(base: string, path: string): string {
  const root = base.trim().replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${root}${suffix}`
}

function request(params: RequestParams): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const options: Parameters<typeof uni.request>[0] = {
      url: params.url,
      method: params.method ?? 'GET',
      header: params.header,
      data: params.data,
      timeout: params.timeout,
      responseType: params.responseType,
      success: (response) =>
        resolve({ statusCode: response.statusCode, data: response.data }),
      fail: (error) => reject(new Error(error?.errMsg || '网络请求失败')),
    }
    uni.request(options)
  })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function arrayOf(value: unknown, key: string): unknown[] {
  const list = record(value)[key]
  return Array.isArray(list) ? list : []
}

function statusOk(code: number): boolean {
  return code >= 200 && code < 300
}

function authHeader(values: Record<string, ConfigValue>): Record<string, string> {
  const apiKey = String(values.apiKey ?? '').trim()
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function baseUrlOf(values: Record<string, ConfigValue>): string {
  return String(values.baseUrl ?? '').trim()
}

function timeoutOf(values: Record<string, ConfigValue>, fallback = 30000): number {
  const value = Number(values.timeoutMs)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function failStatus(response: RawResponse): TestResult {
  if (response.statusCode === 401 || response.statusCode === 403) {
    return {
      ok: false,
      message: `鉴权失败（HTTP ${response.statusCode}），请检查 API Key`,
    }
  }
  const detail =
    typeof response.data === 'string'
      ? response.data.slice(0, 120)
      : JSON.stringify(record(response.data)).slice(0, 120)
  return {
    ok: false,
    message: `服务返回 HTTP ${response.statusCode}${detail && detail !== '{}' ? `：${detail}` : ''}`,
  }
}

function byteLength(data: unknown): number {
  if (typeof data === 'string') return data.length
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  return 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 没有轻量探测接口的厂商，退化为“地址可达”检查 */
async function probe(
  baseUrl: string,
  header: Record<string, string>,
  timeout: number
): Promise<TestResult> {
  const response = await request({ url: baseUrl, header, timeout })
  if (response.statusCode === 401 || response.statusCode === 403) {
    return failStatus(response)
  }
  return {
    ok: true,
    message: `服务可达（HTTP ${response.statusCode}），该厂商没有轻量探测接口`,
  }
}

/**
 * 拉取该厂商可用的模型列表，供设置页把「模型」做成下拉选择。
 * openai 兼容走 GET /models（data[].id）；Ollama 走 GET /api/tags（models[].name）；
 * 其余厂商没有标准列举接口，返回空数组（调用方保留手填/静态选项）。
 */
export async function fetchModelList(
  capability: Capability,
  template: ProviderTemplate,
  values: Record<string, ConfigValue>
): Promise<string[]> {
  const baseUrl = baseUrlOf(values)
  if (!baseUrl) return []
  const timeout = timeoutOf(values)
  const header = {
    'Content-Type': 'application/json',
    ...authHeader(values),
  }
  try {
    if (capability === 'llm' && template.id === 'ollama') {
      const response = await request({ url: joinUrl(baseUrl, '/api/tags'), header, timeout })
      if (!statusOk(response.statusCode)) return []
      return arrayOf(response.data, 'models')
        .map((item) => record(item).name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    }
    if (template.id === 'openai-compatible') {
      const response = await request({ url: joinUrl(baseUrl, '/models'), header, timeout })
      if (!statusOk(response.statusCode)) return []
      return arrayOf(response.data, 'data')
        .map((item) => record(item).id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    }
    return []
  } catch {
    return []
  }
}

export async function testConnection(
  capability: Capability,
  template: ProviderTemplate,
  values: Record<string, ConfigValue>
): Promise<TestResult> {
  const baseUrl = baseUrlOf(values)
  if (!baseUrl) return { ok: false, message: '请先填写服务地址' }

  const timeout = timeoutOf(values)
  const header = {
    'Content-Type': 'application/json',
    ...authHeader(values),
  }

  try {
    switch (`${capability}:${template.id}`) {
      case 'asr:openai-compatible': {
        const response = await request({
          url: joinUrl(baseUrl, '/models'),
          header,
          timeout,
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        const count = arrayOf(response.data, 'data').length
        return {
          ok: true,
          message: count ? `连接成功，服务提供 ${count} 个模型` : '连接成功',
        }
      }

      case 'llm:openai-compatible':
      case 'llm:dashscope':
      case 'llm:deepseek': {
        const response = await request({
          url: joinUrl(baseUrl, '/chat/completions'),
          method: 'POST',
          header,
          timeout,
          data: {
            model: values.model,
            messages: [{ role: 'user', content: '你好' }],
            max_tokens: 8,
            temperature: 0,
            stream: false,
          },
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        const first = record(arrayOf(response.data, 'choices')[0])
        const content = record(first.message).content
        const text = typeof content === 'string' ? content.trim() : ''
        return {
          ok: true,
          message: text
            ? `连接成功，模型回复：${text.slice(0, 40)}`
            : '连接成功',
        }
      }

      case 'llm:ollama': {
        const response = await request({
          url: joinUrl(baseUrl, '/api/tags'),
          header,
          timeout,
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        const count = arrayOf(response.data, 'models').length
        return {
          ok: true,
          message: count ? `连接成功，本地有 ${count} 个模型` : '连接成功',
        }
      }

      case 'llm:agentscope-gateway': {
        const response = await request({
          url: joinUrl(baseUrl, '/health'),
          header,
          timeout,
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        return { ok: true, message: '网关已就绪' }
      }

      case 'tts:openai-compatible': {
        const response = await request({
          url: joinUrl(baseUrl, '/audio/speech'),
          method: 'POST',
          header,
          timeout,
          responseType: 'arraybuffer',
          data: {
            model: values.model,
            input: '你好，我是小熊。',
            voice: values.voice,
            response_format: values.format,
            speed: values.speed,
          },
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        const bytes = byteLength(response.data)
        return bytes
          ? { ok: true, message: `连接成功，返回 ${formatBytes(bytes)} 音频` }
          : { ok: false, message: '接口返回了空音频' }
      }

      case 'tts:kokoro': {
        const response = await request({
          url: joinUrl(baseUrl, '/health'),
          header,
          timeout,
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        const voices = Number(record(response.data).voices)
        return {
          ok: true,
          message: voices ? `连接成功，可用音色 ${voices} 个` : '连接成功',
        }
      }

      case 'asr:funasr': {
        const response = await request({
          url: joinUrl(baseUrl, '/health'),
          header,
          timeout,
        })
        if (!statusOk(response.statusCode)) return failStatus(response)
        return { ok: true, message: 'FunASR 服务已就绪' }
      }

      default:
        return probe(baseUrl, header, timeout)
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '连接失败',
    }
  }
}
