import type { DataService } from '../service/dataService'
import { listLlmModels } from '../service/llmModels'
import { listTtsVoices } from '../service/ttsVoices'
import { listVoiceModels } from '../service/voiceModels'
import { openApiSpec } from '../openapi'

export interface ApiRequest {
  method: string
  pathname: string
  query: URLSearchParams
  body: unknown
}

export interface ApiResult {
  status: number
  body?: unknown
}

/**
 * 对外 REST 接口 controller：集中处理所有 /api/* 请求（含 OpenAPI 文档与数据接口），
 * 只负责解析请求、调用 service、组装响应；参数加密在 server 传输层统一处理。
 *
 * 设置相关接口（长期记忆）统一挂在 /api/admin 下，与通用数据接口（sessions /
 * command-logs）区分开。这是语音助手设置页自己使用的接口，不需要登录。
 *
 * 注意：DataService 的各方法都是异步（Drizzle 查询返回 Promise），这里统一 await，
 * 否则会把 pending Promise 直接 JSON 序列化成了 {}。
 */
export function createApiController(data: DataService, config: { voiceBuiltinUrl: string; voiceDashscopeUrl: string }) {
  return async (req: ApiRequest): Promise<ApiResult> => {
    const { method, pathname, query, body } = req
    const deviceId = query.get('deviceId')

    if (pathname === '/api/health') return { status: 200, body: { ok: true } }
    if (pathname === '/api/openapi.json') return { status: 200, body: openApiSpec }

    if (pathname === '/api/sessions' && method === 'POST') {
      const b = (body ?? {}) as { deviceId?: string; startedAt?: number }
      const id = await data.createSession(b.deviceId ?? deviceId ?? null, b.startedAt ?? Date.now())
      return { status: 201, body: { id } }
    }
    if (pathname === '/api/sessions' && method === 'GET') {
      return { status: 200, body: await data.listSessions(deviceId) }
    }

    if (pathname === '/api/command-logs' && method === 'POST') {
      const b = (body ?? {}) as { command?: string; result?: string }
      const id = await data.insertCommandLog(deviceId ?? null, b.command ?? '', b.result ?? '')
      return { status: 201, body: { id } }
    }
    if (pathname === '/api/command-logs' && method === 'GET') {
      return { status: 200, body: await data.listCommandLogs(deviceId) }
    }

    // 设置接口（/api/admin）：语音助手设置页自己使用，长期记忆按设备维度，不需要登录。
    if (pathname === '/api/admin/memories' && method === 'GET') {
      if (!deviceId) return { status: 400, body: { error: 'deviceId required' } }
      // 分页：page 从 1 起，pageSize 默认 20、上限 100，避免一次拉全量。
      // q 为可选关键词，对 key / value 模糊检索（设置页的检索框使用）。
      const page = Math.max(1, Number(query.get('page')) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize')) || 20))
      const q = query.get('q') ?? undefined
      const result = await data.listMemoriesPage(deviceId, page, pageSize, q)
      return { status: 200, body: { ...result, page, pageSize } }
    }
    if (pathname === '/api/admin/memories' && method === 'DELETE') {
      if (!deviceId) return { status: 400, body: { error: 'deviceId required' } }
      const b = (body ?? {}) as { key?: string }
      // key 优先取请求体，其次取 query（清空记忆时不传 key）；空串表示清空全部。
      const key = b.key ?? query.get('key') ?? ''
      const n = await data.forgetMemory(deviceId, key)
      return { status: 200, body: { deleted: n } }
    }

    // 设置接口（/api/admin）：设置页「保存配置」把整份 AppConfig 落库到网关 SQLite。
    // 免登录、按设备维度；网关只存取 JSON 字符串，不解析不改写配置内容。
    // POST 成功才算「保存成功」——前端据此判断，连不上 / 写失败要如实报错。
    if (pathname === '/api/admin/config' && method === 'POST') {
      if (!deviceId) return { status: 400, body: { error: 'deviceId required' } }
      // body 是整份配置对象（secureRequest POST 的 data）；拒绝非对象，避免脏数据入库。
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { error: 'config object required' } }
      }
      try {
        await data.saveAppConfig(deviceId, JSON.stringify(body))
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }
    if (pathname === '/api/admin/config' && method === 'GET') {
      if (!deviceId) return { status: 400, body: { error: 'deviceId required' } }
      try {
        const config = await data.getAppConfig(deviceId)
        return { status: 200, body: { config: config ? JSON.parse(config) : null } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }

    // 设置接口（/api/admin）：语音助手设置页自身使用，不需要登录。
    // LLM 模型下拉框的数据源：默认按 provider 从网关配置的来源地址拉可选模型
    // （内置=网关 VOICE_BUILTIN_URL；百炼=网关 VOICE_DASHSCOPE_URL + 用户本机 api-key）。
    // 若前端带上了当前选中的来源地址 url（用户设置里的 voice.url，如自建 MAAS 实例），则优先用它——
    // 保证「模型列表」和「真实推理」走同一个地址，避免列表从云端拉、推理打到 MAAS 的模型名错位。
    // 地址由网关持有并中转，前端只与网关通信；url 只作来源地址透传，不落库。
    if (pathname === '/api/admin/llm-models' && method === 'GET') {
      const provider = query.get('provider')
      const apiKey = query.get('apiKey') ?? undefined
      const url = query.get('url') ?? undefined
      if (provider !== 'builtin' && provider !== 'dashscope') {
        return { status: 400, body: { error: 'provider 仅支持 builtin / dashscope' } }
      }
      try {
        const models = await listLlmModels(provider as 'builtin' | 'dashscope', config, apiKey, url)
        return { status: 200, body: { models } }
      } catch (err) {
        return { status: 502, body: { error: (err as Error).message } }
      }
    }

    // 设置接口（/api/admin）：语音助手设置页自身使用，不需要登录。
    // 音色下拉框数据源：两份固定精选目录（内置=Edge-TTS 常用音色；百炼=官方 CosyVoice 标准目录），
    // 均写死、不实时拉取（否则无法国际化），按前端传来的 lang 本地化标签。前端只传 provider + lang。
    if (pathname === '/api/admin/tts-voices' && method === 'GET') {
      const provider = query.get('provider')
      const lang = query.get('lang') ?? undefined
      if (provider !== 'builtin' && provider !== 'dashscope') {
        return { status: 400, body: { error: 'provider 仅支持 builtin / dashscope' } }
      }
      try {
        const result = await listTtsVoices(provider as 'builtin' | 'dashscope', lang)
        return { status: 200, body: result }
      } catch (err) {
        return { status: 502, body: { error: (err as Error).message } }
      }
    }

    // 设置接口（/api/admin）：语音助手设置页自身使用，不需要登录。
    // ASR / TTS 模型下拉框数据源：与 LLM 同理，地址由网关持有并中转，前端只传 provider +
    // capability（asr | tts）；可选带 url（用户当前来源地址，保证列表与真实推理同地址）
    // 与 api-key（内置本地服务非必填，自建实例可能要）。实时目录拉不到时回退官方清单兜底，
    // 保证两个来源永远有得选。详见 service/voiceModels.ts。
    if (pathname === '/api/admin/voice-models' && method === 'GET') {
      const provider = query.get('provider')
      const capability = query.get('capability')
      const apiKey = query.get('apiKey') ?? undefined
      const url = query.get('url') ?? undefined
      if (provider !== 'builtin' && provider !== 'dashscope') {
        return { status: 400, body: { error: 'provider 仅支持 builtin / dashscope' } }
      }
      if (capability !== 'asr' && capability !== 'tts') {
        return { status: 400, body: { error: 'capability 仅支持 asr / tts' } }
      }
      try {
        const models = await listVoiceModels(
          provider as 'builtin' | 'dashscope',
          capability as 'asr' | 'tts',
          config,
          apiKey,
          url,
        )
        return { status: 200, body: { models } }
      } catch (err) {
        return { status: 502, body: { error: (err as Error).message } }
      }
    }

    return { status: 404, body: { error: 'not found' } }
  }
}
