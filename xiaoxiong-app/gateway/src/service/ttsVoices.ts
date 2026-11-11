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
  /** 默认音色的所属模型（与音色一一对应，前端未选时回退用） */
  defaultModel: string
  voices: VoiceOption[]
}

export interface VoiceOption {
  value: string
  label: string
  /** 该音色所属的 TTS 模型（如 cosyvoice-v3-flash）；前端展示为「所属模型」列，并随选择下发，
   *  网关据此决定实际请求的模型——模型不再写死。 */
  model: string
}

/** 单条音色的双语素材：名称/语言各带中英文，性别是二值由函数转成对应词。 */
interface VoiceSeed {
  id: string
  nameZh: string
  nameEn: string
  gender: 'male' | 'female'
  langZh: string
  langEn: string
  /** 该音色所属的 cosyvoice 模型版本；同一音色若多个版本都有，取最好的（v3）。 */
  model: string
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
  return {
    value: seed.id,
    label: `${name}（${seed.id}）· ${gender} · ${language}`,
    model: seed.model,
  }
}

/**
 * 百炼 CosyVoice 官方 cosyvoice-v2 音色目录（id 取自阿里云帮助中心文档）。
 * 关键：本网关 TTS 模型固定 cosyvoice-v2，所以这里的 id 必须都是 v2 可用的精确 id——
 * 一部分带 _v2 后缀（longxiaochun_v2），一部分不带（longhuhu）。切勿混入 cosyvoice-v1 独占的
 * 音色（如 longxiang / longlaotie / loongstella），否则云端会报 418 InvalidParameter。
 */
const DASHSCOPE_VOICES: VoiceSeed[] = [
  // 旗舰 / 语音助手
  { id: 'longyumi_v2', nameZh: 'YUMI', nameEn: 'YUMI', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiaochun_v2', nameZh: '龙小淳', nameEn: 'Longxiaochun', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiaoxia_v2', nameZh: '龙小夏', nameEn: 'Longxiaoxia', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longwan_v2', nameZh: '龙婉', nameEn: 'Longwan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  // 男声
  { id: 'longcheng_v2', nameZh: '龙橙', nameEn: 'Longcheng', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longshu_v2', nameZh: '龙书', nameEn: 'Longshu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longnan_v2', nameZh: '龙楠', nameEn: 'Longnan', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiu_v2', nameZh: '龙修', nameEn: 'Longxiu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longxiaocheng_v2', nameZh: '龙小诚', nameEn: 'Longxiaocheng', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longzhe_v2', nameZh: '龙哲', nameEn: 'Longzhe', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longtian_v2', nameZh: '龙天', nameEn: 'Longtian', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longze_v2', nameZh: '龙泽', nameEn: 'Longze', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longshao_v2', nameZh: '龙邵', nameEn: 'Longshao', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longhao_v2', nameZh: '龙浩', nameEn: 'Longhao', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longhan_v2', nameZh: '龙寒', nameEn: 'Longhan', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'kabuleshen_v2', nameZh: '龙深', nameEn: 'Kabuleshen', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longjielidou_v2', nameZh: '龙杰力豆', nameEn: 'Longjielidou', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English' },
  // 女声（含无 _v2 后缀的 v2 音色）
  { id: 'longhua_v2', nameZh: '龙华', nameEn: 'Longhua', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'loongbella_v2', nameZh: 'Bella2.0', nameEn: 'Bella 2.0', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longmiao_v2', nameZh: '龙妙', nameEn: 'Longmiao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyue_v2', nameZh: '龙悦', nameEn: 'Longyue', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyuan_v2', nameZh: '龙媛', nameEn: 'Longyuan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longfeifei_v2', nameZh: '龙菲菲', nameEn: 'Longfeifei', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longqiang_v2', nameZh: '龙嫱', nameEn: 'Longqiang', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyan_v2', nameZh: '龙颜', nameEn: 'Longyan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longhuhu', nameZh: '龙呼呼', nameEn: 'Longhuhu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanpei', nameZh: '龙安培', nameEn: 'Longanpei', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longdaiyu', nameZh: '龙黛玉', nameEn: 'Longdaiyu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingmu', nameZh: '龙应沐', nameEn: 'Longyingmu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingda', nameZh: '龙应答', nameEn: 'Longyingda', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingjing', nameZh: '龙应静', nameEn: 'Longyingjing', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingyan', nameZh: '龙应严', nameEn: 'Longyingyan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingtian', nameZh: '龙应甜', nameEn: 'Longyingtian', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingbing', nameZh: '龙应冰', nameEn: 'Longyingbing', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingtao', nameZh: '龙应桃', nameEn: 'Longyingtao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingling', nameZh: '龙应聆', nameEn: 'Longyingling', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanran', nameZh: '龙安燃', nameEn: 'Longanran', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanxuan', nameZh: '龙安宣', nameEn: 'Longanxuan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanping', nameZh: '龙安萍', nameEn: 'Longanping', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longbaizhi', nameZh: '龙白芷', nameEn: 'Longbaizhi', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanrou', nameZh: '龙安柔', nameEn: 'Longanrou', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longyingxiao', nameZh: '龙应笑', nameEn: 'Longyingxiao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longjixin', nameZh: '龙机心', nameEn: 'Longjixin', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanli', nameZh: '龙安莉', nameEn: 'Longanli', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longanwen', nameZh: '龙安温', nameEn: 'Longanwen', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longwanjun', nameZh: '龙婉君', nameEn: 'Longwanjun', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  { id: 'longlaoyi', nameZh: '龙老姨', nameEn: 'Longlaoyi', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English' },
  // 方言 / 特色 / 童声 / 机器人
  { id: 'longgaoseng', nameZh: '龙高僧', nameEn: 'Longgaoseng', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longyingxun', nameZh: '龙应询', nameEn: 'Longyingxun', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longyingcui', nameZh: '龙应催', nameEn: 'Longyingcui', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longsanshu', nameZh: '龙三叔', nameEn: 'Longsanshu', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longanchong', nameZh: '龙安冲', nameEn: 'Longanchong', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longanyun', nameZh: '龙安昀', nameEn: 'Longanyun', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longanlang', nameZh: '龙安朗', nameEn: 'Longanlang', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longyichen', nameZh: '龙逸尘', nameEn: 'Longyichen', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longlaobo', nameZh: '龙老伯', nameEn: 'Longlaobo', gender: 'male', langZh: '中文', langEn: 'Chinese' },
  { id: 'longanyue', nameZh: '龙安粤', nameEn: 'Longanyue', gender: 'male', langZh: '中文（粤语）', langEn: 'Cantonese' },
  { id: 'longshange', nameZh: '龙陕哥', nameEn: 'Longshange', gender: 'male', langZh: '中文（陕西话）', langEn: 'Shaanxi dialect' },
  { id: 'longanmin', nameZh: '龙安敏', nameEn: 'Longanmin', gender: 'female', langZh: '中文（闽南话）', langEn: 'Minnan dialect' },
  { id: 'longjiqi', nameZh: '龙机器', nameEn: 'Longjiqi', gender: 'female', langZh: '中文', langEn: 'Chinese' },
  { id: 'longhouge', nameZh: '龙猴哥', nameEn: 'Longhouge', gender: 'male', langZh: '中文', langEn: 'Chinese' },
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
