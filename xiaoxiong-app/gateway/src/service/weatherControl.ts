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
