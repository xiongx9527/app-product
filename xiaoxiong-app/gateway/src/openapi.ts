/**
 * Swagger / OpenAPI 3.0 文档。后端所有接口都在此声明，网关 `/docs` 可视化。
 * 接口定义以 contracts/REST.md 为准。
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'App Product Gateway',
    version: '0.1.0',
    description:
      '语音助手后端网关：语音走 WebSocket（见 contracts/README.md），数据走 REST。前端只允许访问本网关，不直接调用第三方。',
  },
  servers: [{ url: '/' }],
  paths: {
    '/api/health': {
      get: {
        summary: '能力健康检查：汇总 LLM / ASR / TTS 就绪状态',
        responses: {
          '200': {
            description:
              '返回三类能力是否真接入真实引擎（configured）及地址是否可达（reachable）；stub 表示仍是占位桩、功能不可用',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    providers: {
                      type: 'object',
                      properties: {
                        asr: { $ref: '#/components/schemas/ProviderStatus' },
                        llm: { $ref: '#/components/schemas/ProviderStatus' },
                        tts: { $ref: '#/components/schemas/ProviderStatus' },
                        network: { $ref: '#/components/schemas/NetworkStatus' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/sessions': {
      get: {
        summary: '列出会话记录',
        parameters: [{ name: 'deviceId', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: '会话记录列表' } },
      },
      post: {
        summary: '新建会话记录',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { deviceId: { type: 'string' }, startedAt: { type: 'integer' } } },
            },
          },
        },
        responses: { '201': { description: '已创建' } },
      },
    },
    '/api/command-logs': {
      get: {
        summary: '列出命令日志',
        parameters: [{ name: 'deviceId', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: '命令日志列表' } },
      },
      post: {
        summary: '写入命令日志',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } } },
            },
          },
        },
        responses: { '201': { description: '已写入' } },
      },
    },
    '/api/admin/config': {
      post: {
        summary: '保存设置页的整份配置到网关 SQLite（按 deviceId 覆盖更新）',
        description: '语音助手设置页点「保存配置」时调用。body 为整份 AppConfig 对象，网关只存取 JSON、不解析不改写。POST 成功才算保存成功；连不上或写失败前端要如实报错。',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', description: '整份 AppConfig（mode / language / timezone / voice / playback / recommend / general / memory / mcp）', additionalProperties: true },
            },
          },
        },
        responses: {
          '200': { description: '{ ok: true }：已落库' },
          '400': { description: '缺 deviceId 或 body 不是对象' },
          '500': { description: '写库失败，附 error 信息' },
        },
      },
      get: {
        summary: '读回该设备最近一次保存的配置',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ config: AppConfig | null }；未保存过返回 null' },
          '400': { description: '缺 deviceId' },
        },
      },
    },
    '/api/admin/memories': {
      get: {
        summary: '分页列出该设备的长期记忆',
        parameters: [
          { name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 }, description: '页码，从 1 起' },
          { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, description: '每页条数' },
          { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: '关键词，对 key / value 模糊检索' },
        ],
        responses: {
          '200': {
            description: '{ items: 本页记忆(key/value/createdAt/updatedAt)[], total: 总数, page, pageSize }',
          },
          '400': { description: '缺 deviceId' },
        },
      },
      delete: {
        summary: '删除记忆：key 为空清空全部，否则按话题/内容模糊删除',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { key: { type: 'string', description: '要忘的话题/内容关键词；缺省或空串清空全部' } } },
            },
          },
        },
        responses: { '200': { description: '{ deleted: 删除条数 }' }, '400': { description: '缺 deviceId' } },
      },
    },
    '/api/admin/llm-models': {
      get: {
        summary: '列出某来源的 LLM 模型（设置页「LLM 模型」下拉框数据源）',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string', enum: ['builtin', 'dashscope'] }, description: '语音服务来源（地址由网关配置持有并中转，前端不传）' },
          { name: 'apiKey', in: 'query', schema: { type: 'string' }, description: '来源 api-key，只落本机、由前端带来；百炼必带，内置非必填（可空）' },
        ],
        responses: {
          '200': { description: '{ models: string[] }：从来源配置读到的可选模型列表', content: { 'application/json': { schema: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' } } } } } } },
          '400': { description: 'provider 缺失或非法' },
          '502': { description: '无法从来源拉取模型列表' },
        },
      },
    },
    '/api/admin/tts-voices': {
      get: {
        summary: '列出某来源的 TTS 音色（设置页「音色」下拉框数据源；固定精选目录，按 lang 本地化标签）',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string', enum: ['builtin', 'dashscope'] }, description: '语音服务来源（固定目录，不实时拉取）' },
          { name: 'lang', in: 'query', schema: { type: 'string' }, description: '展示语言，如 zh-CN / en；决定标签里的名称、性别、语言的文案，默认 zh-CN' },
        ],
        responses: {
          '200': { description: '{ defaultVoice, voices:[{value,label}] }：从来源读到的可选音色', content: { 'application/json': { schema: { type: 'object', properties: { defaultVoice: { type: 'string' }, voices: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } } } } } } } } },
          '400': { description: 'provider 缺失或非法' },
          '502': { description: '无法从来源拉取音色列表' },
        },
      },
    },
    '/api/admin/voice-models': {
      get: {
        summary: '列出某来源的 ASR / TTS 模型（设置页「ASR 模型 / TTS 模型」下拉框数据源；实时目录 + 官方清单兜底）',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string', enum: ['builtin', 'dashscope'] }, description: '语音服务来源（地址由网关配置持有并中转，前端不传）' },
          { name: 'capability', in: 'query', required: true, schema: { type: 'string', enum: ['asr', 'tts'] }, description: '能力端口：asr=语音识别（对应 9529 的 STT），tts=语音合成' },
          { name: 'apiKey', in: 'query', schema: { type: 'string' }, description: '来源 api-key，只落本机、由前端带来；内置本地服务非必填，自建实例可能要' },
          { name: 'url', in: 'query', schema: { type: 'string' }, description: '用户当前来源地址（如自建 9529 实例），让列表与真实推理同地址；不传则用网关默认地址' },
        ],
        responses: {
          '200': { description: '{ models: string[] }：该能力端口的可选模型列表（实时目录合并官方兜底，保证非空）', content: { 'application/json': { schema: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' } } } } } } },
          '400': { description: 'provider / capability 缺失或非法' },
          '502': { description: '无法从来源拉取模型列表（且兜底也失败，理论上不会触发）' },
        },
      },
    },
    '/music/stream': {
      get: {
        summary:
          'B 站音轨代理：直链带防盗链（需 Referer），由网关代拉并流式转发给客户端播放器；仅放行白名单 CDN 域名，支持 Range 与重定向',
        parameters: [
          { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'B 站音轨直链（白名单域）' },
        ],
        responses: {
          '200': { description: '音频流（或 206 分段）' },
          '206': { description: '按 Range 返回的分段内容' },
          '400': { description: 'url 缺失或域名不在白名单' },
          '502': { description: '上游拉取失败' },
        },
      },
    },
  },
  components: {
    schemas: {
      ProviderStatus: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '提供商名（builtin/dashscope/stub…）' },
          configured: { type: 'boolean', description: '是否真接入真实引擎（stub 为 false）' },
          reachable: { type: 'boolean', description: '真实引擎地址是否可达' },
          message: { type: 'string', description: '人类可读状态' },
          endpoint: { type: 'string', description: '真实引擎地址 host:port（stub 时无）' },
        },
      },
      NetworkStatus: {
        type: 'object',
        properties: {
          reachable: { type: 'boolean', description: '能否访问外网（百度 / B 站任一可达即视为可达）' },
          message: { type: 'string', description: '人类可读状态' },
          host: { type: 'string', description: '成功连通的外网主机 host:port（不可达时无）' },
        },
      },
    },
  },
}
