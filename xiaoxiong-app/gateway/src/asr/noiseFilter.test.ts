import { describe, it, expect } from 'vitest'
import { isNoise, isForeignNoise, resemblesSpoken, pcmRms, stripTrailingEcho } from './noiseFilter'

describe('ASR 杂音过滤', () => {
  it('纯符号、空白、幻觉短词判为噪声', () => {
    expect(isNoise('**&……%¥#@')).toBe(true)
    expect(isNoise('   ')).toBe(true)
    expect(isNoise('Yeah.')).toBe(true)
    expect(isNoise('Yes.')).toBe(true)
    // 实机高频：SenseVoice 把静音/音乐回声识别成英文冠词碎片
    expect(isNoise('The')).toBe(true)
    expect(isNoise('the.')).toBe(true)
    expect(isNoise('A')).toBe(true)
    expect(isNoise('嗯。')).toBe(true)
    expect(isNoise('谢谢观看')).toBe(true)
  })

  it('正常短问句放行，不误杀实义单字', () => {
    expect(isNoise('今天天气怎么样')).toBe(false)
    expect(isNoise('滚。')).toBe(false)
    expect(isNoise('好')).toBe(false)
  })

  it('咳嗽/清嗓/犹豫被识别成叠字拟声 → 判噪声，不触发一轮回答', () => {
    expect(isNoise('嗯嗯')).toBe(true)
    expect(isNoise('咳咳')).toBe(true)
    expect(isNoise('嗯额')).toBe(true)
    expect(isNoise('呃呃呃')).toBe(true)
    expect(isNoise('咳，咳咳。')).toBe(true)
    // 打嗝/呃逆被 SenseVoice 识别成「嗯哼」「嗝」类拟声（真机 2026-11-18）：叠用与单字都判噪声
    expect(isNoise('嗯哼')).toBe(true)
    expect(isNoise('嗯哼。')).toBe(true)
    expect(isNoise('嗝')).toBe(true)
    expect(isNoise('嗝嗝')).toBe(true)
    expect(isNoise('哼哼')).toBe(true)
    expect(isNoise('哎')).toBe(true)
    expect(isNoise('哎哎')).toBe(true)
    // 「我/你/数字」类幻觉由 VAD 幻觉二级判断（isHallucinationShort）接管，不在这里堆字
    expect(isNoise('你好')).toBe(false)
    expect(isNoise('你能播放吗')).toBe(false)
    // 实义叠字/带实义词不放行误杀
    expect(isNoise('好好')).toBe(false)
    expect(isNoise('是是')).toBe(false)
    expect(isNoise('对对')).toBe(false)
    expect(isNoise('嗯，播放音乐')).toBe(false)
  })

  it('极短英文虚词碎片判为噪声，任何会话语言下都拦', () => {
    // 实机高频：SenseVoice 把静音/音乐回声识别成英文虚词，进 LLM 会胡乱追问「你说的The没听清」
    expect(isNoise('The')).toBe(true)
    expect(isNoise('yeah')).toBe(true)
    expect(isNoise('Oh yeah')).toBe(true)
    expect(isNoise('the, the')).toBe(true)
    expect(isNoise('OK.')).toBe(true)
    // 用户 2026-11-16 实测新增的高频碎片：代词/系动词单独成句也拦
    expect(isNoise('she')).toBe(true)
    expect(isNoise('She.')).toBe(true)
    expect(isNoise('he is')).toBe(true)
    expect(isNoise('it is the')).toBe(true)
    // 字母级幻觉：单个拉丁字母单独出现一律拦
    expect(isNoise('H')).toBe(true)
    expect(isNoise('H.')).toBe(true)
    expect(isNoise('e')).toBe(true)
  })

  it('中英混排、英文歌名、纯数字选号、实义短句都不误杀', () => {
    expect(isNoise('来一首 Taylor Swift 的歌')).toBe(false)
    expect(isNoise('周杰伦的歌')).toBe(false)
    expect(isNoise('9')).toBe(false) // 选号
    expect(isNoise('The Beatles')).toBe(false) // 实义词，非纯虚词
    expect(isNoise('播放音乐')).toBe(false)
  })

  it('与刚播报的内容高度雷同判为回声', () => {
    const spoken = ['你好，我是小熊语音助手，有什么可以帮你？']
    expect(resemblesSpoken('你好，我是小熊语音助手，有什么可以帮你？', spoken)).toBe(true)
    expect(resemblesSpoken('我是小熊语音助手', spoken)).toBe(true)
    expect(resemblesSpoken('那明天天气呢？', spoken)).toBe(false)
  })

  it('pcmRms 反映幅度，静音帧为 0', () => {
    expect(pcmRms(new Uint8Array(320))).toBe(0)
    const loud = new Int16Array(160)
    loud.fill(8000)
    expect(pcmRms(new Uint8Array(loud.buffer))).toBeCloseTo(8000 / 32768, 3)
  })
})

describe('isForeignNoise（中文会话下的纯外文短句幻觉）', () => {
  it('中文会话：纯英文短句（儿童/环境幻觉）判为噪声', () => {
    expect(isForeignNoise('hello baby', 'zh-CN')).toBe(true)
    expect(isForeignNoise('oh my god', 'zh-CN')).toBe(true)
    expect(isForeignNoise('go go go', 'zh-CN')).toBe(true)
    expect(isForeignNoise('what is this', 'zh-CN')).toBe(true)
  })
  it('中文会话：中英混排 / 数字 / 长英文句放行', () => {
    expect(isForeignNoise('Taylor Swift 的歌', 'zh-CN')).toBe(false)
    expect(isForeignNoise('9', 'zh-CN')).toBe(false)
    expect(isForeignNoise('播放音乐', 'zh-CN')).toBe(false)
    expect(isForeignNoise('this is a much longer english sentence here', 'zh-CN')).toBe(false)
  })
  it('英文会话不启用该过滤', () => {
    expect(isForeignNoise('hello baby', 'en-US')).toBe(false)
  })
})

describe('stripTrailingEcho（去掉 SenseVoice 句尾多吐的重复词）', () => {
  it('真机案例：今天天气怎么样？天气。→ 今天天气怎么样？', () => {
    expect(stripTrailingEcho('今天天气怎么样？天气。')).toBe('今天天气怎么样？')
    expect(stripTrailingEcho('今天天气怎么样？天气')).toBe('今天天气怎么样？')
  })

  it('其它标点 / 重复片段也去掉', () => {
    expect(stripTrailingEcho('今天几号？几号。')).toBe('今天几号？')
    expect(stripTrailingEcho('播放音乐吧！音乐吧。')).toBe('播放音乐吧！')
  })

  it('真机案例：带朗读动词的无标点词组重复（朗诵滕王阁序滕王阁序 → 朗诵滕王阁序）', () => {
    expect(stripTrailingEcho('朗诵滕王阁序滕王阁序')).toBe('朗诵滕王阁序')
    expect(stripTrailingEcho('背诵静夜思静夜思')).toBe('背诵静夜思')
    expect(stripTrailingEcho('朗诵岳阳楼记岳阳楼记')).toBe('朗诵岳阳楼记')
  })

  it('词组折叠绝不误伤唤醒词/真实 A+A 表达', () => {
    // 唤醒词和真实重复表达没有朗读动词，必须原样保留（否则唤醒失效）
    expect(stripTrailingEcho('小熊小熊')).toBe('小熊小熊')
    expect(stripTrailingEcho('搜索搜索')).toBe('搜索搜索')
    expect(stripTrailingEcho('取消取消')).toBe('取消取消')
    expect(stripTrailingEcho('走走停停')).toBe('走走停停')
    expect(stripTrailingEcho('走吧？走')).toBe('走吧？走')
    expect(stripTrailingEcho('去北京？上海也行。')).toBe('去北京？上海也行。')
    expect(stripTrailingEcho('朗诵滕王阁序')).toBe('朗诵滕王阁序')
  })

  it('尾部是全新内容（不是重复）时保留', () => {
    expect(stripTrailingEcho('去北京？上海也行。')).toBe('去北京？上海也行。')
    expect(stripTrailingEcho('先吃饭。然后散步。')).toBe('先吃饭。然后散步。')
  })

  it('无句末标点 / 单字尾巴不处理（避免误伤正常强调）', () => {
    expect(stripTrailingEcho('今天天气怎么样')).toBe('今天天气怎么样')
    expect(stripTrailingEcho('走吧？走')).toBe('走吧？走')
    expect(stripTrailingEcho('好。好')).toBe('好。好')
  })

  it('空串原样返回', () => {
    expect(stripTrailingEcho('')).toBe('')
  })
})
