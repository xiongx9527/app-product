import type { Capability, ProviderField, ProviderTemplate } from './types'

const apiKeyField = (required = false): ProviderField => ({
  key: 'apiKey',
  label: 'API Key',
  type: 'password',
  placeholder: required ? '必填' : '本地服务可留空',
  hint: '只保存本机；填写后会带 Authorization: Bearer',
})

const timeoutField = (value: number): ProviderField => ({
  key: 'timeoutMs',
  label: '超时（毫秒）',
  type: 'number',
  min: 1000,
  max: 300000,
  step: 1000,
  hint: `本地大模型首次加载可能较慢，默认 ${value}`,
})

const systemPromptField = (value: string): ProviderField => ({
  key: 'systemPrompt',
  label: 'System Prompt',
  type: 'textarea',
  placeholder: '你是一个中文语音助手，回答简短口语化。',
  hint: value,
})

const ASR_PROVIDERS: ProviderTemplate[] = [
  {
    id: 'openai-compatible',
    vendor: 'OpenAI 兼容',
    name: 'openai-voice / OpenAI / 任意兼容网关',
    description:
      'POST /audio/transcriptions。本地 9529 端口的 openai-voice（SenseVoice / Whisper）即属于这一类。',
    defaults: {
      baseUrl: 'http://127.0.0.1:9529/v1',
      model: 'sensevoice-small',
      language: '',
      responseFormat: 'json',
      temperature: 0,
      apiKey: '',
      timeoutMs: 30000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:9529/v1' },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'sensevoice-small（本地 SenseVoice）', value: 'sensevoice-small' },
          { label: 'whisper-1（Whisper）', value: 'whisper-1' },
        ],
      },
      {
        key: 'language',
        label: '识别语言',
        type: 'text',
        placeholder: '留空 = 跟随全局',
        hint: 'OpenAI 风格填 zh；留空时使用全局语言',
      },
      {
        key: 'responseFormat',
        label: '返回格式',
        type: 'select',
        options: [
          { label: 'json（推荐，带时间戳）', value: 'json' },
          { label: 'text（只要文本）', value: 'text' },
          { label: 'verbose_json', value: 'verbose_json' },
        ],
      },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1, step: 0.1 },
      apiKeyField(),
      timeoutField(30000),
    ],
  },
  {
    id: 'dashscope',
    vendor: '阿里云 DashScope',
    name: 'Paraformer / SenseVoice 云端识别',
    description: '阿里云百炼语音识别。需要 API Key，按量计费。',
    defaults: {
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'paraformer-realtime-v2',
      language: 'zh',
      sampleRate: 16000,
      apiKey: '',
      timeoutMs: 30000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'https://dashscope.aliyuncs.com/api/v1' },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'paraformer-realtime-v2（实时）', value: 'paraformer-realtime-v2' },
          { label: 'paraformer-v2（文件）', value: 'paraformer-v2' },
          { label: 'sensevoice-v1', value: 'sensevoice-v1' },
        ],
      },
      {
        key: 'language',
        label: '识别语言',
        type: 'select',
        options: [
          { label: '中文 zh', value: 'zh' },
          { label: '英文 en', value: 'en' },
          { label: '粤语 yue', value: 'yue' },
          { label: '日文 ja', value: 'ja' },
          { label: '韩文 ko', value: 'ko' },
        ],
      },
      { key: 'sampleRate', label: '采样率', type: 'number', min: 8000, max: 48000, step: 1000 },
      apiKeyField(true),
      timeoutField(30000),
    ],
  },
  {
    id: 'funasr',
    vendor: 'FunASR 自建',
    name: 'paraformer-zh + VAD + 标点',
    description: '自建 FunASR 服务（HTTP / WebSocket），离线可用，不需要云账号。',
    defaults: {
      baseUrl: 'http://127.0.0.1:10095',
      mode: 'http',
      model: 'paraformer-zh',
      vadModel: 'fsmn-vad',
      puncModel: 'ct-punc',
      language: 'zh',
      apiKey: '',
      timeoutMs: 30000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:10095' },
      {
        key: 'mode',
        label: '接入方式',
        type: 'select',
        options: [
          { label: 'HTTP（整段音频）', value: 'http' },
          { label: 'WebSocket（流式）', value: 'websocket' },
        ],
      },
      { key: 'model', label: '识别模型', type: 'text', placeholder: 'paraformer-zh' },
      { key: 'vadModel', label: 'VAD 模型', type: 'text', placeholder: 'fsmn-vad' },
      { key: 'puncModel', label: '标点模型', type: 'text', placeholder: 'ct-punc' },
      {
        key: 'language',
        label: '识别语言',
        type: 'select',
        options: [
          { label: '中文 zh', value: 'zh' },
          { label: '英文 en', value: 'en' },
        ],
      },
      apiKeyField(),
      timeoutField(30000),
    ],
  },
]

const LLM_PROVIDERS: ProviderTemplate[] = [
  {
    id: 'openai-compatible',
    vendor: 'OpenAI 兼容',
    name: '任意 /v1/chat/completions 服务',
    description:
      '最常见的接入方式。本地 Ollama 的 OpenAI 兼容端点（/v1）、vLLM、各家云厂商兼容模式都走这里。',
    defaults: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'gpt-oss:120b-cloud',
      apiKey: '',
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: '你是一个中文语音助手，回答简短、口语化，适合直接朗读。',
      stream: true,
      timeoutMs: 60000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:11434/v1' },
      { key: 'model', label: '模型名', type: 'text', placeholder: 'gpt-oss:120b-cloud' },
      apiKeyField(),
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'maxTokens', label: '最大输出 Token', type: 'number', min: 16, max: 32768, step: 16 },
      systemPromptField('语音场景建议限长，回答会被直接朗读'),
      { key: 'stream', label: '流式输出', type: 'switch' },
      timeoutField(60000),
    ],
  },
  {
    id: 'ollama',
    vendor: 'Ollama',
    name: '本地模型原生接口',
    description: '走 Ollama 原生 /api/chat，支持 num_ctx 等本地参数。',
    defaults: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'gpt-oss:120b-cloud',
      temperature: 0.7,
      numCtx: 8192,
      systemPrompt: '你是一个中文语音助手，回答简短、口语化，适合直接朗读。',
      stream: true,
      apiKey: '',
      timeoutMs: 120000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:11434' },
      { key: 'model', label: '模型名', type: 'text', placeholder: 'gpt-oss:120b-cloud' },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'numCtx', label: '上下文长度 num_ctx', type: 'number', min: 512, max: 131072, step: 512 },
      systemPromptField('语音场景建议限长，回答会被直接朗读'),
      { key: 'stream', label: '流式输出', type: 'switch' },
      apiKeyField(),
      timeoutField(120000),
    ],
  },
  {
    id: 'dashscope',
    vendor: '阿里云 DashScope',
    name: '通义千问（兼容模式）',
    description: '走 DashScope 的 OpenAI 兼容端点，模型可换 qwen 系列。',
    defaults: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: '',
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: '你是一个中文语音助手，回答简短、口语化，适合直接朗读。',
      stream: true,
      timeoutMs: 60000,
    },
    fields: [
      {
        key: 'baseUrl',
        label: '服务地址',
        type: 'text',
        placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'qwen-plus', value: 'qwen-plus' },
          { label: 'qwen-turbo', value: 'qwen-turbo' },
          { label: 'qwen-max', value: 'qwen-max' },
          { label: 'qwen3-max', value: 'qwen3-max' },
        ],
      },
      apiKeyField(true),
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'maxTokens', label: '最大输出 Token', type: 'number', min: 16, max: 32768, step: 16 },
      systemPromptField('语音场景建议限长，回答会被直接朗读'),
      { key: 'stream', label: '流式输出', type: 'switch' },
      timeoutField(60000),
    ],
  },
  {
    id: 'deepseek',
    vendor: 'DeepSeek',
    name: 'deepseek-chat / reasoner',
    description: '官方 API，OpenAI 兼容。',
    defaults: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: '你是一个中文语音助手，回答简短、口语化，适合直接朗读。',
      stream: true,
      timeoutMs: 60000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'deepseek-chat', value: 'deepseek-chat' },
          { label: 'deepseek-reasoner', value: 'deepseek-reasoner' },
        ],
      },
      apiKeyField(true),
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'maxTokens', label: '最大输出 Token', type: 'number', min: 16, max: 32768, step: 16 },
      systemPromptField('语音场景建议限长，回答会被直接朗读'),
      { key: 'stream', label: '流式输出', type: 'switch' },
      timeoutField(60000),
    ],
  },
  {
    id: 'agentscope-gateway',
    vendor: 'AgentScope 网关',
    name: 'AgentScope 2（TypeScript）',
    description:
      '复杂 Agent 操作走自建 Node 网关：工具调用、多步任务、MCP。网关内部再调 LLM 厂商，客户端只连这一个地址。',
    defaults: {
      baseUrl: 'http://127.0.0.1:8080',
      agentName: 'assistant',
      sessionMode: 'session',
      apiKey: '',
      stream: true,
      timeoutMs: 120000,
    },
    fields: [
      { key: 'baseUrl', label: '网关地址', type: 'text', placeholder: 'http://127.0.0.1:8080' },
      { key: 'agentName', label: 'Agent 名称', type: 'text', placeholder: 'assistant' },
      {
        key: 'sessionMode',
        label: '会话模式',
        type: 'select',
        options: [
          { label: '有状态（多轮记忆）', value: 'session' },
          { label: '无状态（每次带历史）', value: 'stateless' },
        ],
      },
      apiKeyField(),
      { key: 'stream', label: '流式输出', type: 'switch' },
      timeoutField(120000),
    ],
  },
]

const TTS_PROVIDERS: ProviderTemplate[] = [
  {
    id: 'openai-compatible',
    vendor: 'OpenAI 兼容',
    name: 'openai-voice / OpenAI / 任意兼容网关',
    description:
      'POST /audio/speech。本地 9529 端口同时提供 edge-tts 与 kokoro 两种模型，可切换格式与采样率。',
    defaults: {
      baseUrl: 'http://127.0.0.1:9529/v1',
      model: 'edge-tts',
      voice: 'zh-CN-XiaoxiaoNeural',
      format: 'mp3',
      sampleRate: 24000,
      speed: 1,
      apiKey: '',
      timeoutMs: 60000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:9529/v1' },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'edge-tts（微软在线音色）', value: 'edge-tts' },
          { label: 'kokoro（本地离线）', value: 'kokoro' },
        ],
      },
      {
        key: 'voice',
        label: '音色',
        type: 'select',
        options: [
          { label: '晓晓 · 女声（推荐）', value: 'zh-CN-XiaoxiaoNeural' },
          { label: '晓伊 · 女声', value: 'zh-CN-XiaoyiNeural' },
          { label: '云希 · 男声', value: 'zh-CN-YunxiNeural' },
          { label: '云健 · 男声', value: 'zh-CN-YunjianNeural' },
          { label: '云扬 · 男声', value: 'zh-CN-YunyangNeural' },
          { label: '辽宁小北 · 女声', value: 'zh-CN-liaoning-XiaobeiNeural' },
        ],
      },
      {
        key: 'format',
        label: '返回格式',
        type: 'select',
        options: [
          { label: 'mp3（体积小）', value: 'mp3' },
          { label: 'wav（无损）', value: 'wav' },
          { label: 'pcm（流式播放）', value: 'pcm' },
        ],
      },
      { key: 'sampleRate', label: '采样率', type: 'number', min: 8000, max: 48000, step: 1000 },
      { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.1 },
      apiKeyField(),
      timeoutField(60000),
    ],
  },
  {
    id: 'kokoro',
    vendor: 'Kokoro',
    name: '本地离线 TTS（9530）',
    description: '本机 kokoro-voice 容器，100 个音色，支持 pcm / wav 流式，无外部依赖。',
    defaults: {
      baseUrl: 'http://127.0.0.1:9530',
      model: 'kokoro',
      voice: 'zf_xiaoxiao',
      format: 'wav',
      sampleRate: 24000,
      speed: 1,
      apiKey: '',
      timeoutMs: 120000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:9530' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'kokoro' },
      {
        key: 'voice',
        label: '音色 ID',
        type: 'text',
        placeholder: 'zf_xiaoxiao',
        hint: '中文常用 zf_ / zm_ 前缀；完整列表见 /health 或容器文档',
      },
      {
        key: 'format',
        label: '返回格式',
        type: 'select',
        options: [
          { label: 'wav', value: 'wav' },
          { label: 'pcm（流式播放）', value: 'pcm' },
        ],
      },
      { key: 'sampleRate', label: '采样率', type: 'number', min: 8000, max: 48000, step: 1000 },
      { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.1 },
      apiKeyField(),
      timeoutField(120000),
    ],
  },
  {
    id: 'dashscope',
    vendor: '阿里云 DashScope',
    name: 'CosyVoice 语音合成',
    description: '阿里云 CosyVoice，音色多、音质好，按量计费。',
    defaults: {
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'cosyvoice-v2',
      voice: 'longxiaochun',
      format: 'mp3',
      sampleRate: 24000,
      speed: 1,
      apiKey: '',
      timeoutMs: 30000,
    },
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'https://dashscope.aliyuncs.com/api/v1' },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: [
          { label: 'cosyvoice-v2', value: 'cosyvoice-v2' },
          { label: 'cosyvoice-v1', value: 'cosyvoice-v1' },
        ],
      },
      {
        key: 'voice',
        label: '音色',
        type: 'select',
        options: [
          { label: '龙小淳', value: 'longxiaochun' },
          { label: '龙小夏', value: 'longxiaoxia' },
          { label: '龙婉', value: 'longwan' },
        ],
      },
      {
        key: 'format',
        label: '返回格式',
        type: 'select',
        options: [
          { label: 'mp3', value: 'mp3' },
          { label: 'wav', value: 'wav' },
          { label: 'pcm', value: 'pcm' },
        ],
      },
      { key: 'sampleRate', label: '采样率', type: 'number', min: 8000, max: 48000, step: 1000 },
      { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.1 },
      apiKeyField(true),
      timeoutField(30000),
    ],
  },
]

/**
 * 音乐播放源：与 asr/llm/tts 同构的 BYOK 配置。
 * 各厂商只声明「参数」，具体怎么把 genre/关键词解析成可播放地址由网关负责；
 * 客户端只把选中的 provider + 参数随 session.start 上报。
 */
const MUSIC_PROVIDERS: ProviderTemplate[] = [
  {
    id: 'soma',
    vendor: 'SomaFM 免费电台',
    name: '无需 Key 的国外网络电台',
    description: '免费的互联网电台（轻电子/爵士/人声等），直接 mp3 流，无需任何账号。',
    defaults: {
      station: 'groovesalad',
    },
    fields: [
      {
        key: 'station',
        label: '默认频道',
        type: 'select',
        options: [
          { label: 'Groove Salad（轻电子/氛围）', value: 'groovesalad' },
          { label: 'Drone Zone（极简氛围）', value: 'dronezone' },
          { label: 'Lush（柔和人声）', value: 'lush' },
          { label: 'Indie Pop（独立流行）', value: 'indiepop' },
          { label: 'Sonic Universe（爵士）', value: 'sonicuniverse' },
          { label: 'Seven Inch Soul（灵歌/节奏）', value: '7soul' },
        ],
      },
    ],
  },
  {
    id: 'custom',
    vendor: '自定义电台',
    name: '你自己填一个音频流地址',
    description: '完全不固定来源：填一个可直接播放的音频流/歌单直链（自建电台、网络收音机等）。',
    defaults: {
      streamUrl: '',
      title: '',
    },
    fields: [
      { key: 'streamUrl', label: '音频流地址', type: 'text', placeholder: 'https://.../xxx.mp3 或 m3u8' },
      { key: 'title', label: '展示标题（可选）', type: 'text', placeholder: '留空用地址本身' },
    ],
  },
  {
    id: 'netease',
    vendor: '网易云音乐',
    name: '公开 Web API 搜歌播放',
    description: '走网易云公开接口搜歌并取直链，无需 Key（限速/偶发 403，属尽力而为）。',
    defaults: {
      limit: 1,
    },
    fields: [
      { key: 'limit', label: '返回候选数', type: 'number', min: 1, max: 10, step: 1 },
    ],
  },
  {
    id: 'qq',
    vendor: 'QQ 音乐',
    name: '公开 Web API 搜歌播放',
    description: '走 QQ 音乐公开接口搜歌并取直链，无需 Key（部分 VIP 歌曲无直链）。',
    defaults: {
      limit: 1,
    },
    fields: [
      { key: 'limit', label: '返回候选数', type: 'number', min: 1, max: 30, step: 1 },
    ],
  },
  {
    id: 'spotify',
    vendor: 'Spotify',
    name: '需 clientId / clientSecret',
    description: '用你的 Spotify 应用凭据取 token 并搜歌，播放 30 秒试听（Spotify 开放接口限制）。',
    defaults: {
      clientId: '',
      clientSecret: '',
    },
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'text', placeholder: 'Spotify 应用 ID' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', placeholder: 'Spotify 应用 Secret' },
    ],
  },
]

export const PROVIDERS: Record<Capability, ProviderTemplate[]> = {
  asr: ASR_PROVIDERS,
  llm: LLM_PROVIDERS,
  tts: TTS_PROVIDERS,
  music: MUSIC_PROVIDERS,
}

export function findProvider(
  capability: Capability,
  id: string
): ProviderTemplate | undefined {
  return PROVIDERS[capability].find((item) => item.id === id)
}
