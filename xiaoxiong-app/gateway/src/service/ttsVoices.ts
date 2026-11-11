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
 * 百炼 CosyVoice 官方音色目录（id 逐条取自阿里云帮助中心「CosyVoice 音色列表」，
 * 2026-10-11 版 https://www.alibabacloud.com/help/zh/model-studio/cosyvoice-voice-list）。
 *
 * 官方硬性约束：「所选音色(voice)须在当前模型(model)的音色列表中」「每个模型仅支持特定
 * 音色组，不能混用」。v1 音色（如 longxiang）配 v3 模型、或拼凑不存在的 _v3 id，云端都会
 * 返回 418 Invalid voice / InvalidParameter，整句静音——这正是之前「没有播报」的根因。
 * 因此这里只登记官方确认属于 cosyvoice-v3-flash 的 voice id，不再编造或混入 v2 无后缀音色。
 *
 * 每条都带所属模型（model 字段）；模型不写死在网关：前端把所选音色的 model 随
 * params.model 下发，网关据此请求对应模型。v3-flash 与 v3-plus 共用同一套音色。
 */
export const DASHSCOPE_DEFAULT_MODEL = 'cosyvoice-v3-flash'
/** 默认音色：YUMI（longyumi_v3，官方「语音助手」场景，最贴合本助手对讲）。 */
export const DASHSCOPE_DEFAULT_VOICE = 'longyumi_v3'
const V3 = DASHSCOPE_DEFAULT_MODEL
const DASHSCOPE_VOICES: VoiceSeed[] = [
  // 社交陪伴 / 标杆
  { id: 'longanyang', nameZh: '龙安洋', nameEn: 'Longanyang', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanhuan', nameZh: '龙安欢', nameEn: 'Longanhuan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanhuan_v3', nameZh: '龙安欢(V3)', nameEn: 'Longanhuan V3', gender: 'female', langZh: '中文、英文（多方言）', langEn: 'Chinese, English (dialects)', model: V3 },
  // 语音助手（默认 YUMI）
  { id: 'longyumi_v3', nameZh: 'YUMI', nameEn: 'YUMI', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longxiaochun_v3', nameZh: '龙小淳', nameEn: 'Longxiaochun', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longxiaoxia_v3', nameZh: '龙小夏', nameEn: 'Longxiaoxia', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanyun_v3', nameZh: '龙安昀', nameEn: 'Longanyun', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanwen_v3', nameZh: '龙安温', nameEn: 'Longanwen', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanli_v3', nameZh: '龙安莉', nameEn: 'Longanli', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanlang_v3', nameZh: '龙安朗', nameEn: 'Longanlang', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingmu_v3', nameZh: '龙应沐', nameEn: 'Longyingmu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 童声 / 智能玩具
  { id: 'longhuhu_v3', nameZh: '龙呼呼', nameEn: 'Longhuhu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longpaopao_v3', nameZh: '龙泡泡', nameEn: 'Longpaopao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longjielidou_v3', nameZh: '龙杰力豆', nameEn: 'Longjielidou', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longxian_v3', nameZh: '龙仙', nameEn: 'Longxian', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longling_v3', nameZh: '龙铃', nameEn: 'Longling', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longshanshan_v3', nameZh: '龙闪闪', nameEn: 'Longshanshan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longniuniu_v3', nameZh: '龙牛牛', nameEn: 'Longniuniu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 方言
  { id: 'longjiaxin_v3', nameZh: '龙嘉欣', nameEn: 'Longjiaxin', gender: 'female', langZh: '中文（粤语）', langEn: 'Cantonese', model: V3 },
  { id: 'longjiayi_v3', nameZh: '龙嘉怡', nameEn: 'Longjiayi', gender: 'female', langZh: '中文（粤语）', langEn: 'Cantonese', model: V3 },
  { id: 'longanyue_v3', nameZh: '龙安粤', nameEn: 'Longanyue', gender: 'male', langZh: '中文（粤语）', langEn: 'Cantonese', model: V3 },
  { id: 'longlaotie_v3', nameZh: '龙老铁', nameEn: 'Longlaotie', gender: 'male', langZh: '中文（东北话）', langEn: 'Northeastern dialect', model: V3 },
  { id: 'longshange_v3', nameZh: '龙陕哥', nameEn: 'Longshange', gender: 'male', langZh: '中文（陕西话）', langEn: 'Shaanxi dialect', model: V3 },
  { id: 'longanmin_v3', nameZh: '龙安闽', nameEn: 'Longanmin', gender: 'female', langZh: '中文（闽南话）', langEn: 'Minnan dialect', model: V3 },
  // 客服 / 电话销售 / 诗词
  { id: 'longfei_v3', nameZh: '龙飞', nameEn: 'Longfei', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingxiao_v3', nameZh: '龙应笑', nameEn: 'Longyingxiao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingxun_v3', nameZh: '龙应询', nameEn: 'Longyingxun', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingjing_v3', nameZh: '龙应静', nameEn: 'Longyingjing', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingling_v3', nameZh: '龙应聆', nameEn: 'Longyingling', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyingtao_v3', nameZh: '龙应桃', nameEn: 'Longyingtao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 社交陪伴 / 男女声
  { id: 'longantai_v3', nameZh: '龙安台', nameEn: 'Longantai', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longhua_v3', nameZh: '龙华', nameEn: 'Longhua', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longcheng_v3', nameZh: '龙橙', nameEn: 'Longcheng', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longze_v3', nameZh: '龙泽', nameEn: 'Longze', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longzhe_v3', nameZh: '龙哲', nameEn: 'Longzhe', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyan_v3', nameZh: '龙颜', nameEn: 'Longyan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longxing_v3', nameZh: '龙星', nameEn: 'Longxing', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longtian_v3', nameZh: '龙天', nameEn: 'Longtian', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longwan_v3', nameZh: '龙婉', nameEn: 'Longwan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longqiang_v3', nameZh: '龙嫱', nameEn: 'Longqiang', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longfeifei_v3', nameZh: '龙菲菲', nameEn: 'Longfeifei', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longhao_v3', nameZh: '龙浩', nameEn: 'Longhao', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanrou_v3', nameZh: '龙安柔', nameEn: 'Longanrou', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longhan_v3', nameZh: '龙寒', nameEn: 'Longhan', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanzhi_v3', nameZh: '龙安智', nameEn: 'Longanzhi', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanling_v3', nameZh: '龙安灵', nameEn: 'Longanling', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanya_v3', nameZh: '龙安雅', nameEn: 'Longanya', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanqin_v3', nameZh: '龙安亲', nameEn: 'Longanqin', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 有声书
  { id: 'longmiao_v3', nameZh: '龙妙', nameEn: 'Longmiao', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longsanshu_v3', nameZh: '龙三叔', nameEn: 'Longsanshu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyuan_v3', nameZh: '龙媛', nameEn: 'Longyuan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyue_v3', nameZh: '龙悦', nameEn: 'Longyue', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longxiu_v3', nameZh: '龙修', nameEn: 'Longxiu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longnan_v3', nameZh: '龙楠', nameEn: 'Longnan', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longwanjun_v3', nameZh: '龙婉君', nameEn: 'Longwanjun', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longyichen_v3', nameZh: '龙逸尘', nameEn: 'Longyichen', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longlaobo_v3', nameZh: '龙老伯', nameEn: 'Longlaobo', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longlaoyi_v3', nameZh: '龙老姨', nameEn: 'Longlaoyi', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 短视频配音 / 直播带货 / 新闻播报
  { id: 'longjiqi_v3', nameZh: '龙机器', nameEn: 'Longjiqi', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longhouge_v3', nameZh: '龙猴哥', nameEn: 'Longhouge', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longdaiyu_v3', nameZh: '龙黛玉', nameEn: 'Longdaiyu', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanran_v3', nameZh: '龙安燃', nameEn: 'Longanran', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longanxuan_v3', nameZh: '龙安宣', nameEn: 'Longanxuan', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longshuo_v3', nameZh: '龙硕', nameEn: 'Longshuo', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'longshu_v3', nameZh: '龙书', nameEn: 'Longshu', gender: 'male', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  { id: 'loongbella_v3', nameZh: 'Bella3.0', nameEn: 'Bella 3.0', gender: 'female', langZh: '中文、英文', langEn: 'Chinese, English', model: V3 },
  // 出海营销（英文 / 日 / 韩）
  { id: 'loongabby_v3', nameZh: 'Abby', nameEn: 'Abby', gender: 'female', langZh: '英文（美式）', langEn: 'American English', model: V3 },
  { id: 'loongandy_v3', nameZh: 'Andy', nameEn: 'Andy', gender: 'male', langZh: '英文（美式）', langEn: 'American English', model: V3 },
  { id: 'loongannie_v3', nameZh: 'Annie', nameEn: 'Annie', gender: 'female', langZh: '英文（美式）', langEn: 'American English', model: V3 },
  { id: 'loongdavid_v3', nameZh: 'David', nameEn: 'David', gender: 'male', langZh: '英文（美式）', langEn: 'American English', model: V3 },
  { id: 'loongemily_v3', nameZh: 'Emily', nameEn: 'Emily', gender: 'female', langZh: '英文（英式）', langEn: 'British English', model: V3 },
  { id: 'loongeric_v3', nameZh: 'Eric', nameEn: 'Eric', gender: 'male', langZh: '英文（英式）', langEn: 'British English', model: V3 },
  { id: 'loongyuuna_v3', nameZh: 'Yuuna', nameEn: 'Yuuna', gender: 'female', langZh: '日文', langEn: 'Japanese', model: V3 },
  { id: 'loongjihun_v3', nameZh: 'Jihun', nameEn: 'Jihun', gender: 'male', langZh: '韩文', langEn: 'Korean', model: V3 },
]

/**
 * voice 是否属于指定 cosyvoice 模型的官方音色目录。
 * v3-flash / v3-plus 共用同一套音色；其它模型（含未来新增）不拦截，交云端判定，避免网关误伤。
 */
export function isDashscopeVoiceValid(model: string, voice: string): boolean {
  const family = model === 'cosyvoice-v3-plus' ? DASHSCOPE_DEFAULT_MODEL : model
  if (family !== DASHSCOPE_DEFAULT_MODEL) return true
  return DASHSCOPE_VOICES.some((v) => v.id === voice)
}

/** 把非法 / 陈旧音色（如旧 v1 的 longxiang）收敛成该模型的默认音色，
 *  否则云端会回 418 Invalid voice，整句静音——这正是「有回答却没播报」的直接原因。 */
export function resolveDashscopeVoice(model: string, voice: string): string {
  return isDashscopeVoiceValid(model, voice) ? voice : DASHSCOPE_DEFAULT_VOICE
}

/** 内置语音服务精选目录（以 Edge-TTS 常用音色为主；写死以便国际化，不实时拉取）。 */
const BUILTIN_VOICES: VoiceSeed[] = [
  { id: 'zh-CN-XiaoxiaoNeural', nameZh: '晓晓', nameEn: 'Xiaoxiao', gender: 'female', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'zh-CN-YunxiNeural', nameZh: '云希', nameEn: 'Yunxi', gender: 'male', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'zh-CN-YunyangNeural', nameZh: '云扬', nameEn: 'Yunyang', gender: 'male', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'zh-CN-XiaoyiNeural', nameZh: '晓伊', nameEn: 'Xiaoyi', gender: 'female', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'zh-CN-YunjianNeural', nameZh: '云健', nameEn: 'Yunjian', gender: 'male', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'zh-CN-XiaochenNeural', nameZh: '晓辰', nameEn: 'Xiaochen', gender: 'female', langZh: '中文', langEn: 'Chinese', model: 'edge-tts' },
  { id: 'en-US-AriaNeural', nameZh: '艾莉娅', nameEn: 'Aria', gender: 'female', langZh: '英文', langEn: 'English', model: 'edge-tts' },
  { id: 'en-US-GuyNeural', nameZh: '盖伊', nameEn: 'Guy', gender: 'male', langZh: '英文', langEn: 'English', model: 'edge-tts' },
  { id: 'en-US-JennyNeural', nameZh: '珍妮', nameEn: 'Jenny', gender: 'female', langZh: '英文', langEn: 'English', model: 'edge-tts' },
]

export async function listTtsVoices(
  provider: 'builtin' | 'dashscope',
  lang?: string,
): Promise<VoiceList> {
  if (provider === 'dashscope') {
    return {
      defaultVoice: DASHSCOPE_DEFAULT_VOICE,
      defaultModel: DASHSCOPE_DEFAULT_MODEL,
      voices: DASHSCOPE_VOICES.map((v) => formatVoice(v, lang)),
    }
  }
  // 内置：固定精选目录，不再实时去语音服务拉取（实时内容无法国际化）。
  return {
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    defaultModel: 'edge-tts',
    voices: BUILTIN_VOICES.map((v) => formatVoice(v, lang)),
  }
}
