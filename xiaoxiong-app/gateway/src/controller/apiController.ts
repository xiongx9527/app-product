import type { DataService } from '../service/dataService'
import { listLlmModels } from '../service/llmModels'
import { listTtsVoices } from '../service/ttsVoices'
import { listVoiceModels } from '../service/voiceModels'
import { openApiSpec } from '../openapi'
import { pinyin } from 'pinyin-pro'
import { loadAsrCorrections } from '../service/voiceSessionService'
import { isProperNounTarget } from '../service/autoLearn'

/** 管理端加纠错词校验（与自动学习同口径，2026-11-19）：正确词须是专有名词、from/to 字数相等、2–6 字。 */
function validateCorrectionItem(correct: string, wrong: string): string | null {
  const c = correct.trim(), w = wrong.trim()
  if (c === w) return '正确词和错词不能一样'
  if (!/^[\u4e00-\u9fff]+$/.test(c) || !/^[\u4e00-\u9fff]+$/.test(w)) return '正确词和错词都必须是纯中文'
  if (c.length < 2 || c.length > 6 || w.length < 2 || w.length > 6) return '正确词和错词都必须是 2–6 字'
  if (c.length !== w.length) return '正确词和错词字数必须一样'
  if (!isProperNounTarget(c)) return '正确词必须是专有名词（人名/地名/作品名/诗词名/歌名/品牌），不能是短语'
  if (!isProperNounTarget(w)) return '错词也必须是专有名词形态（如「李存序」），不能是「打乒乓」这类动词短语'
  return null
}

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

    // 设置接口（/api/admin/asr-corrections）：ASR 纠错词表（两表，全局非设备维度）。
    // GET 列出主表+各字表；POST 批量加 {items:[{correct, wrong, note?}]}；
    // DELETE ?correct=X&wrong=Y 删某错词 / ?correct=X 停用整条热词。改后立即刷新内存纠正器。
    const refreshCorrector = async () => loadAsrCorrections(await data.listFlatAsrCorrections())
    if (pathname === '/api/admin/asr-corrections' && method === 'GET') {
      try {
        const mains = await data.listMainAsrCorrections()
        const items = await Promise.all(mains.map(async (m) => ({
          ...m,
          variants: await data.listAsrVariants(m.correct),
        })))
        return { status: 200, body: { corrections: items } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }
    if (pathname === '/api/admin/asr-corrections' && method === 'POST') {
      // 批量：{items:[{correct, wrong, note?}]}；也兼容单条 {correct, wrong}。
      const b = body as {
        items?: Array<{ correct?: string; wrong?: string; note?: string }>
        correct?: string; wrong?: string; note?: string
      } | null
      const rawItems = b?.items ?? (b ? [b] : [])
      const items = rawItems.filter((x) => x && typeof x.correct === 'string' && x.correct.trim()
        && typeof x.wrong === 'string' && x.wrong.trim())
      if (!items.length) {
        return { status: 400, body: { error: '需提供 correct→wrong 项（单条或 items 数组）' } }
      }
      const toPy = (w: string) => pinyin(w, { toneType: 'none', type: 'array' }).join(' ')
      // 管理端也按新规则校验（用户 2026-11-19）：非法项跳过并汇总原因，不让垃圾词进词表
      const rejected: Array<{ correct: string; wrong: string; reason: string }> = []
      const valid = items.filter((x) => {
        const err = validateCorrectionItem(x.correct!, x.wrong!)
        if (err) rejected.push({ correct: x.correct!.trim(), wrong: x.wrong!.trim(), reason: err })
        return !err
      })
      if (!valid.length) {
        return { status: 400, body: { error: '所有纠错项都不符合规则', rejected } }
      }
      try {
        const mainIds = new Map<string, number>()
        for (const x of valid) {
          const correct = x.correct!.trim()
          const wrong = x.wrong!.trim()
          let id = mainIds.get(correct)
          if (!id) {
            id = await data.upsertAsrCorrection({ correct, pinyin: toPy(correct) })
            mainIds.set(correct, id)
          }
          await data.upsertAsrVariant(id, {
            wrong, pinyin: toPy(wrong), ...(x.note ? { note: x.note } : {}),
          })
        }
        await refreshCorrector()
        return { status: 200, body: { ok: true, count: valid.length, rejected } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }
    if (pathname === '/api/admin/asr-corrections' && method === 'DELETE') {
      // all=1：物理清空整张纠错词表（开发调试清污染数据用，seed 合法词会在下次 init 重建）
      if (query.get('all') === '1') {
        try {
          const deleted = await data.clearAsrCorrections()
          await refreshCorrector()
          return { status: 200, body: { ok: true, ...deleted } }
        } catch (err) {
          return { status: 500, body: { error: (err as Error).message } }
        }
      }
      const correct = query.get('correct')
      const wrong = query.get('wrong')
      if (!correct) return { status: 400, body: { error: 'correct 必填' } }
      try {
        if (wrong) await data.disableAsrVariant(correct, wrong) // 删某错词
        else await data.disableAsrCorrection(correct) // 停用整条
        await refreshCorrector()
        return { status: 200, body: { ok: true } }
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
    // 音色下拉框数据源：内置=网关中转 9529 的实时音色目录（9529 开启鉴权时需带 API-Key，
    // 由前端把本机密钥带来）；百炼=官方标准目录，按 lang 本地化标签。
    if (pathname === '/api/admin/tts-voices' && method === 'GET') {
      const provider = query.get('provider')
      const lang = query.get('lang') ?? undefined
      const apiKey = query.get('apiKey') ?? undefined
      if (provider !== 'builtin' && provider !== 'dashscope') {
        return { status: 400, body: { error: 'provider 仅支持 builtin / dashscope' } }
      }
      try {
        const result = await listTtsVoices(provider as 'builtin' | 'dashscope', lang, {
          voiceBuiltinUrl: config.voiceBuiltinUrl,
          apiKey,
        })
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
