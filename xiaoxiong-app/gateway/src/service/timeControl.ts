/**
 * 时间类高置信意图的确定性识别：命中后绕开大模型，直接用网关本地时钟口播。
 * 用户反馈「问现在几点了为啥还走大模型、好慢」——这类问题答案确定、无需 LLM，
 * 按 AGENTS.md「少调 LLM：高置信控制指令直连绕开大模型」直接落地。
 * 只拦明确问时间/日期的句子；含糊的「时间都去哪了」等不拦，交后续逻辑。
 */
const TIME_INTENT =
  /几点|几时|什么时间|什么时刻|报时|现在时间|当前时间|几号|几月几[号日]|什么日期|什么日子|星期几|周几|礼拜几|今天几号|今天是[星期周几]|日历/

/** 文本是否为「问现在几点 / 今天几号 / 星期几」这类时间查询。 */
export function detectTimeCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return TIME_INTENT.test(t)
}
