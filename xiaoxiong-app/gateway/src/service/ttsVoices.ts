/**
 * 列出某来源的 TTS 音色（设置页「音色」下拉框数据源）。
 *
 * 与 LLM 模型同理：地址由网关持有并中转，前端只传 provider + 可选 api-key。
 * 但音色目录是「固定目录」而非「实时拉取」：
 * - 百炼（dashscope）：DashScope 的 CosyVoice 没有「列举音色」的开放接口，使用阿里云官方文档
 *   给出的标准 CosyVoice 音色目录（官方音色 ID，随官方文档更新；不写死地址）。
 * - 内置（builtin）：同样写死一份精选目录（以 Edge-TTS 常用音色为主），不再实时去语音服务拉
 *   /voice/v1/audio/voices——因为实时拉回来的描述无法国际化。写死后每条都带中/英名称与语言，
 *   由网关按前端传来的 lang 本地化标签。
 *
 * 标签本地化：前端把当前语言通过 `lang` 传进来（默认 zh-CN），网关据此拼出对应语言的
 * 「名称（id）· 性别 · 语言」标签，前端只负责渲染、不做翻译。
 */

export interface VoiceList {
  /** 该来源的默认音色（前端未选时回退用） */
  defaultVoice: string
  voices: VoiceOption[]
}

export interface VoiceOption {
  value: string
  label: string
}

/** 单条音色的双语素材：名称/语言各带中英文，性别是二值由函数转成对应词。 */
interface VoiceSeed {
  id: string
  nameZh: string
  nameEn: string
  gender: 'male' | 'female'
  langZh: string
  langEn: string
}

function isEn(lang?: string): boolean {
  return !!lang && lang.toLowerCase().startsWith('en')
}

function genderLabel(gender: 'male' | 'female', en: boolean): string {
  if (en) return gender === 'female' ? 'Female' : 'Male'
  return gender === 'female' ? '女' : '男'
}

function formatVoice(seed: VoiceSeed, lang?: string): VoiceOption {
  const en = isEn(lang)
  const name = en ? seed.nameEn : seed.nameZh
  const gender = genderLabel(seed.gender, en)
  const language = en ? seed.langEn : seed.langZh
  return { value: seed.id, label: `${name}（${seed.id}）· ${gender} · ${language}` }
}

/** 百炼 CosyVoice 官方标准音色目录（cosyvoice-v1；名称/性别/语言出自阿里云帮助中心文档）。 */
const DASHSCOPE_VOICES: VoiceSeed[] = [
  { id: 'longxiaoxia', nameZh: '龙小夏', nameEn: 'Longxiaoxia', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longwan', nameZh: '龙婉', nameEn: 'Longwan', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longcheng', nameZh: '龙橙', nameEn: 'Longcheng', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longhua', nameZh: '龙华', nameEn: 'Longhua', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longxiaochun', nameZh: '龙小淳', nameEn: 'Longxiaochun', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiaocheng', nameZh: '龙小诚', nameEn: 'Longxiaocheng', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiaobai', nameZh: '龙小白', nameEn: 'Longxiaobai', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longlaotie', nameZh: '龙老铁', nameEn: 'Longlaotie', gender: 'male', langZh: '中文东北口音', langEn: 'Northeastern Chinese' },
  { id: 'longshu', nameZh: '龙书', nameEn: 'Longshu', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longshuo', nameZh: '龙硕', nameEn: 'Longshuo', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longjing', nameZh: '龙婧', nameEn: 'Longjing', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longmiao', nameZh: '龙妙', nameEn: 'Longmiao', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longyue', nameZh: '龙悦', nameEn: 'Longyue', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longyuan', nameZh: '龙媛', nameEn: 'Longyuan', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longfei', nameZh: '龙飞', nameEn: 'Longfei', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longjielidou', nameZh: '龙杰力豆', nameEn: 'Longjielidou', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longtong', nameZh: '龙彤', nameEn: 'Longtong', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longxiang', nameZh: '龙祥', nameEn: 'Longxiang', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'loongstella', nameZh: 'Stella', nameEn: 'Stella', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'loongbella', nameZh: 'Bella', nameEn: 'Bella', gender: 'female', langZh: '中文', langEn: 'Chinese' },
]

/** 内置语音服务精选目录（以 Edge-TTS 常用音色为主；写死以便国际化，不实时拉取）。 */
const BUILTIN_VOICES: VoiceSeed[] = [
  { id: 'zh-CN-XiaoxiaoNeural', nameZh: '晓晓', nameEn: 'Xiaoxiao', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'zh-CN-YunxiNeural', nameZh: '云希', nameEn: 'Yunxi', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'zh-CN-YunyangNeural', nameZh: '云扬', nameEn: 'Yunyang', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'zh-CN-XiaoyiNeural', nameZh: '晓伊', nameEn: 'Xiaoyi', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'zh-CN-YunjianNeural', nameZh: '云健', nameEn: 'Yunjian', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'zh-CN-XiaochenNeural', nameZh: '晓辰', nameEn: 'Xiaochen', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'en-US-AriaNeural', nameZh: '艾莉娅', nameEn: 'Aria', gender: 'female', langZh: '英文', langEn: 'English' },
  { id: 'en-US-GuyNeural', nameZh: '盖伊', nameEn: 'Guy', gender: 'male', langZh: '英文', langEn: 'English' },
  { id: 'en-US-JennyNeural', nameZh: '珍妮', nameEn: 'Jenny', gender: 'female', langZh: '英文', langEn: 'English' },
]

export async function listTtsVoices(
  provider: 'builtin' | 'dashscope',
  lang?: string,
): Promise<VoiceList> {
  if (provider === 'dashscope') {
    return {
      defaultVoice: 'longxiaoxia',
      voices: DASHSCOPE_VOICES.map((v) => formatVoice(v, lang)),
    }
  }
  // 内置：固定精选目录，不再实时去语音服务拉取（实时内容无法国际化）。
  return {
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    voices: BUILTIN_VOICES.map((v) => formatVoice(v, lang)),
  }
}
