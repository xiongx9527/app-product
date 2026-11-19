/**
 * 天气类高置信意图的确定性识别：命中后绕开大模型，直接调天气数据源口播。
 * 用户反馈「问天气也好慢」——天气本就是工具查询、答案确定，不该先过一遍 LLM。
 * 只拦明确问天气的句子；音乐/点歌等由 handleDirectCommand 里更靠前的检测优先消费。
 */
const WEATHER_INTENT =
  /天气|气温|多少度|几度|温度|下不下雨|会不会下雨|要下雨|带伞|冷不冷|热不热|穿什么|降温|升温|空气湿度|天气预报/

/** 文本是否为「今天天气怎么样 / 多少度 / 下雨吗」这类天气查询。 */
export function detectWeatherCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return WEATHER_INTENT.test(t)
}

/**
 * 从天气问句里提取指定城市名（如「北京天气怎么样」→「北京」）；无城市名返回 null（查当前位置）。
 * 城市名取天气意图词之前的名词片段，剥掉口语前缀（查/看看/问一下/的/今天…）。
 * 只取较短短片段（≤10字），避免把整句当城市名。用户可用「XX天气」明确指定。
 */
const CITY_FILLERS = [
  '帮我', '请', '查一下', '查询一下', '查查', '查询', '查', '看一下', '看看', '看下',
  '问下', '问一下', '告诉我', '给我', '说一下', '说说', '播报一下', '播报',
  '今天', '今日', '明天', '现在', '这会儿', '的', '天气', '在',
]
export function extractWeatherCity(text: string): string | null {
  const t = (text || '').trim()
  if (!t) return null
  // 天气意图词在句首（如「天气怎么样」）→ 无城市名
  const intentIdx = t.search(WEATHER_INTENT)
  if (intentIdx <= 0) return null
  // 城市名 = 意图词之前的片段，循环剥掉口语前缀
  let s = t.slice(0, intentIdx).trim()
  let changed = true
  while (changed) {
    changed = false
    for (const w of CITY_FILLERS) {
      if (s.startsWith(w)) { s = s.slice(w.length).trim(); changed = true }
    }
  }
  // 去结尾的「的」（「深圳的天气」→「深圳」）和标点；纯时间词/空串不算城市名
  s = s.replace(/的$/, '').trim()
  s = s.replace(/^[，,。.、\s？?！!]+|[，,。.、\s？?！!]+$/g, '').trim()
  if (!s || s.length > 10) return null
  // 纯时间/泛词不当城市名
  if (/^(今天|今日|明天|后天|现在|这会儿|当地|这里)$/.test(s)) return null
  return s
}
