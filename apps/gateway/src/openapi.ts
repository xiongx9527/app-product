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
      get: { summary: '健康检查', responses: { '200': { description: 'ok' } } },
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
  },
}
