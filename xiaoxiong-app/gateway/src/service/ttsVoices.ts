/**
 * 列出某来源的 TTS 音色（设置页「音色」下拉框数据源）。
 *
 * 与 LLM 模型同理：地址由网关持有并中转，前端只传 provider；网关再向 9529 本地语音服务
 * 取真实目录，前端只负责渲染。
 *
 * 数据来源（避免两端两套目录对不上）：
 * - 内置（builtin）：直接中转 9529 的 /voice/v1/audio/voices。该目录由 voice.db / seed 维护，
 *   每条带 desc_zh / desc_en（中英文描述），是 TTS 真正使用的同一份数据。网关不再写死一份
 *   「精选 N 条」——此前就是网关另写了一份目录，才和真实引擎两条线、对不上，用户在下拉里
 *   看到的既不是真实全集、描述也对不齐。9529 不可达时回退到下面这份内置清单（仅降级用）。
 *   该接口与其他 /voice 数据接口同样受 VOICE_API_KEY_AUTH 约束：开启后网关带上用户填的
 *   api-key（Authorization: Bearer），否则会拿到 401 并静默降级成兜底清单。
 * - 百炼（dashscope）：DashScope 的 CosyVoice 没有「列举音色」的开放接口，云端地址也不放目录，
 *   因此保留一份官方标准目录（官方音色 ID + 中英文名称/语言，按前端 lang 本地化标签）。
 *
 * 标签本地化：dashscope 由网关按 lang 拼标签；builtin 的描述（desc_zh / desc_en）来自 9529，
 * 前端按 lang 选其一展示。
 */

export interface VoiceList {
  /** 该来源的默认音色（前端未选时由 9529 内部兜底，前端不强制选中） */
  defaultVoice: string
  /** 默认音色的所属模型 */
  defaultModel: string
  /** 该来源的调用协议（http / ws / http-async），透传给前端参考 */
  protocol?: string
  voices: VoiceOption[]
}

export interface VoiceOption {
  /** 音色 id（如 zh-CN-XiaoxiaoNeural / longyumi_v3），前端随选择下发网关 */
  value: string
  /** 展示名：内置即 id；百炼为「名称（id）· 性别 · 语言」 */
  label: string
  /** 该音色所属的 TTS 模型；前端展示为「所属模型」列，并随选择下发，网关据此决定实际请求的模型 */
  model: string
  /** 中文描述（来自 9529 目录） */
  descZh?: string
  /** 英文描述（来自 9529 目录） */
  descEn?: string
}

/** 内置降级清单（仅当 9529 不可达时回退；正常情况以内置服务的实时目录为准）。 */
const BUILTIN_VOICES_FALLBACK: { id: string; descZh: string; descEn: string; isDefault?: boolean }[] = [
  { id: 'zh-CN-XiaoxiaoNeural', descZh: '女声·温柔自然（默认）', descEn: 'Female · gentle and natural (default)', isDefault: true },
  { id: 'zh-CN-YunxiNeural', descZh: '男声·年轻活泼', descEn: 'Male · young and lively' },
  { id: 'zh-CN-YunyangNeural', descZh: '男声·专业新闻播报', descEn: 'Male · professional news broadcast' },
  { id: 'zh-CN-XiaoyiNeural', descZh: '女声·活泼可爱', descEn: 'Female · lively and cute' },
  { id: 'zh-CN-YunjianNeural', descZh: '男声·成熟稳重', descEn: 'Male · mature and steady' },
  { id: 'zh-CN-YunxiaNeural', descZh: '女声·甜美', descEn: 'Female · sweet' },
  { id: 'zh-CN-XiaoxuanNeural', descZh: '女声·清新', descEn: 'Female · fresh' },
  { id: 'zh-TW-HsiaoChenNeural', descZh: '女声·台湾腔', descEn: 'Female · Taiwanese accent' },
  { id: 'zh-TW-YunJheNeural', descZh: '男声·台湾腔', descEn: 'Male · Taiwanese accent' },
  { id: 'zh-TW-HsiaoYuNeural', descZh: '女声·台湾腔·温柔', descEn: 'Female · Taiwanese accent · gentle' },
  { id: 'zh-HK-HiuGaaiNeural', descZh: '女声·粤语', descEn: 'Female · Cantonese' },
  { id: 'zh-HK-WanLungNeural', descZh: '男声·粤语', descEn: 'Male · Cantonese' },
  { id: 'zh-HK-HiuMaanNeural', descZh: '女声·粤语·活泼', descEn: 'Female · Cantonese · lively' },
  { id: 'en-US-AriaNeural', descZh: '女声·自然通用', descEn: 'Female · natural and versatile' },
  { id: 'en-US-GuyNeural', descZh: '男声·沉稳', descEn: 'Male · calm' },
  { id: 'en-US-JennyNeural', descZh: '女声·亲切', descEn: 'Female · friendly' },
  { id: 'en-GB-SoniaNeural', descZh: '女声·优雅英音', descEn: 'Female · elegant British accent' },
  { id: 'en-GB-RyanNeural', descZh: '男声·英音', descEn: 'Male · British accent' },
  { id: 'ja-JP-NanamiNeural', descZh: '女声·柔和', descEn: 'Female · soft' },
  { id: 'ja-JP-KeitaNeural', descZh: '男声·清晰', descEn: 'Male · clear' },
]

// ── 以下百炼部分保持原样（音色调用的旧格式、官方约束校验均不动） ──

/** 单条音色的双语素材：名称/性别/语言各带中英文。 */
interface DashscopeVoiceSeed {
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

function dashscopeFormat(seed: DashscopeVoiceSeed, lang?: string): { value: string; label: string; model: string } {
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
const DASHSCOPE_VOICES: DashscopeVoiceSeed[] = [
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

/**
 * 内置音色目录：优先中转 9529 本地语音服务的 /voice/v1/audio/voices（voice.db / seed 维护、
 * 含 desc_zh / desc_en，与真实 TTS 同源）；9529 不可达时回退到内置降级清单，保证设置页仍可用。
 */
async function listBuiltinVoices(
  builtinUrl: string,
  apiKey?: string,
): Promise<VoiceList> {
  const base = (builtinUrl || 'http://127.0.0.1:9529').replace(/\/+$/, '')
  try {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const res = await fetch(`${base}/voice/v1/audio/voices?provider=builtin`, { headers })
    if (!res.ok) throw new Error(`voice catalog upstream ${res.status}`)
    const data = (await res.json()) as {
      default?: string
      model?: string
      protocol?: string
      voices?: Array<{ id: string; model?: string; desc_zh?: string; desc_en?: string; is_default?: boolean }>
    }
    const voices: VoiceOption[] = (data.voices ?? []).map((v) => ({
      value: v.id,
      label: v.id,
      model: v.model ?? data.model ?? 'edge-tts',
      descZh: v.desc_zh || undefined,
      descEn: v.desc_en || undefined,
    }))
    return {
      defaultVoice: data.default ?? (BUILTIN_VOICES_FALLBACK.find((v) => v.isDefault)?.id ?? BUILTIN_VOICES_FALLBACK[0].id),
      defaultModel: data.model ?? 'edge-tts',
      protocol: data.protocol || 'http',
      voices,
    }
  } catch {
    // 降级：9529 不可达时仍给一份可用清单（无实时目录增量）。
    return {
      defaultVoice: BUILTIN_VOICES_FALLBACK.find((v) => v.isDefault)?.id ?? BUILTIN_VOICES_FALLBACK[0].id,
      defaultModel: 'edge-tts',
      protocol: 'http',
      voices: BUILTIN_VOICES_FALLBACK.map((v) => ({
        value: v.id,
        label: v.id,
        model: 'edge-tts',
        descZh: v.descZh,
        descEn: v.descEn,
      })),
    }
  }
}

export async function listTtsVoices(
  provider: 'builtin' | 'dashscope',
  lang?: string,
  config?: { voiceBuiltinUrl?: string; apiKey?: string },
): Promise<VoiceList> {
  if (provider === 'dashscope') {
    return {
      defaultVoice: DASHSCOPE_DEFAULT_VOICE,
      defaultModel: DASHSCOPE_DEFAULT_MODEL,
      voices: DASHSCOPE_VOICES.map((v) => dashscopeFormat(v, lang)),
    }
  }
  return listBuiltinVoices(config?.voiceBuiltinUrl ?? '', config?.apiKey)
}
