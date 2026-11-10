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
    '/api/device-data': {
      get: {
        summary: '列出设备数据',
        parameters: [{ name: 'deviceId', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: '设备数据列表' } },
      },
      post: {
        summary: '写入设备数据',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { type: { type: 'string' }, payload: { type: 'object' } } },
            },
          },
        },
        responses: { '201': { description: '已写入' } },
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
    '/api/assistant/memories': {
      get: {
        summary: '列出该设备的长期记忆',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '记忆列表（key/value/updatedAt）' }, '400': { description: '缺 deviceId' } },
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
    '/api/assistant/voice-config': {
      get: {
        summary: '读取该设备的语音服务配置（内置 / DashScope）',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '当前配置（provider/url/apiKey）' }, '400': { description: '缺 deviceId' } },
      },
      post: {
        summary: '保存该设备的语音服务配置（内置 / DashScope）',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  provider: { type: 'string', enum: ['builtin', 'dashscope'], description: '语音服务来源' },
                  url: { type: 'string', description: '服务地址；内置可编辑，DashScope 有默认值' },
                  apiKey: { type: 'string', description: 'API 密钥（落库加密）' },
                },
              },
            },
          },
        },
        responses: { '200': { description: '{ id, voice }' }, '400': { description: '缺 deviceId' } },
      },
      put: {
        summary: '更新该设备的语音服务配置（与 POST 语义一致，幂等覆盖）',
        parameters: [{ name: 'deviceId', in: 'query', required: true, schema: { type: 'string' } }],
        requestBody: { $ref: '#/paths/~1api~1assistant~1voice-config/post/requestBody' },
        responses: { '200': { description: '{ id, voice }' }, '400': { description: '缺 deviceId' } },
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
          provider: { type: 'string', description: '提供商名（whisper/edge/ollama/stub…）' },
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
