/**
 * 高置信「择吉日 / 黄历宜忌」意图的确定性识别：命中后绕开大模型，
 * 直接用 lunar-javascript 内置的权威黄历宜忌数据扫未来日期并口播。
 * 用户需求「能做推荐好日子吗 吉日」「日子要包括农历阳历」——黄历宜忌是库内置的
 * 传统历法数据（非编造），答案确定，按 AGENTS.md「少调 LLM」直连落地。
 * 注意与日期直连区分：「今天是什么日子」问的是今天是几号（timeControl），
 * 不含吉日触发词、不会进这里；「推荐个吉日 / 好日子」才是择日。
 */

/** 触发词：明确在问择日 / 黄历 */
const AUSPICIOUS_TRIGGER = /吉日|黄道吉日|良辰|好日子|黄历|宜忌|择日/

/** 常见事项 → 黄历「宜」词映射：口语词命中后按黄历标准词匹配宜列表。 */
const ACTIVITY_WORDS: Array<{ re: RegExp; label: string; yi: string[] }> = [
  { re: /结婚|嫁娶|办喜事|喜酒|婚期/, label: '嫁娶', yi: ['嫁娶'] },
  { re: /领证|结婚登记/, label: '领证', yi: ['嫁娶', '纳采'] },
  { re: /订婚|提亲/, label: '订婚', yi: ['纳采', '订盟'] },
  { re: /搬家|搬屋|迁居|乔迁/, label: '搬家', yi: ['移徙', '入宅'] },
  { re: /入住|进宅|入伙/, label: '入住', yi: ['入宅', '移徙'] },
  { re: /开业|开张|开店|开工/, label: '开业', yi: ['开市', '交易', '立券'] },
  { re: /装修|动土|破土动工/, label: '动土', yi: ['动土', '修造'] },
  { re: /出行|旅游|旅行|出门|远行/, label: '出行', yi: ['出行'] },
  { re: /签约|签合同|签协议/, label: '签约', yi: ['立券', '交易'] },
  { re: /安床/, label: '安床', yi: ['安床'] },
  { re: /祭祀|祭拜|上香|扫墓/, label: '祭祀', yi: ['祭祀'] },
  { re: /祈福|还愿|拜佛/, label: '祈福', yi: ['祈福'] },
  { re: /求子/, label: '求嗣', yi: ['求嗣'] },
  { re: /安葬|下葬/, label: '安葬', yi: ['安葬', '破土'] },
  { re: /提车/, label: '提车', yi: ['出行', '纳财'] },
  { re: /进货|收账|收租|进财/, label: '纳财', yi: ['纳财', '开仓'] },
]

/** 择日识别结果：activity 为空表示泛吉日（没说具体事项，推荐宜最多的日子）。 */
export interface AuspiciousQuery {
  /** 口语事项名（搬家 / 结婚…），null 表示没说具体事项 */
  activity: string | null
  /** 对应的黄历「宜」标准词，命中任一即算宜该事项 */
  yiWords: string[]
}

/** 识别择吉日意图：null 表示不是这类句子，交给后续逻辑。 */
export function detectAuspiciousQuery(text: string): AuspiciousQuery | null {
  const t = text.trim()
  if (!t || !AUSPICIOUS_TRIGGER.test(t)) return null
  for (const a of ACTIVITY_WORDS) {
    if (a.re.test(t)) return { activity: a.label, yiWords: a.yi }
  }
  return { activity: null, yiWords: [] }
}
