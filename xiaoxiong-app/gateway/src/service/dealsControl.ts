/**
 * 「查商品 / 找好价」这类高置信泛查询的确定性识别：命中后绕开 LLM 直接调 dealsTool。
 *
 * 只拦意图明确的句子：
 * - 含优惠/好价信号词（打折、优惠、折扣、好价、便宜…），这些词本身就是购物语境；
 * - 或明确的商品查询/搜索动作（查询商品、搜索商品、有什么便宜的…）。
 *
 * 单独出现的泛词「东西 / 商品 / 买卖」不在此拦截——它们太泛（「把东西拿过来」
 * 「这商品怎么样」「买卖不成仁义在」），只写进工具 description 交给 LLM 结合上下文判断，
 * 避免把正常对话劫持成查好价。与音乐/音量/记忆等既有直连命令互斥：本检测放在
 * handleDirectCommand 最后，其它命令都没命中才轮到它。
 */
const DEAL_SIGNAL = /打折|优惠|折扣|好价|特价|促销|秒杀|清仓|降价|划算|省钱|白菜价|史低/
const CHEAP_PRODUCT = /便宜.{0,6}(东西|商品|货|买|入手|有啥|有什么)|(东西|商品|货).{0,4}便宜/
const PRODUCT_QUERY =
  /(查询|搜索|搜一?下|查一?下|找一?找|找找|有没有|有什么|推荐|来点|给点).{0,6}(商品|东西|好价|优惠|折扣|便宜|划算|买卖)/

/** 文本是否为「查询/搜索商品或好价」的高置信泛查询。带具体商品名的句子不在此拦，
 *  交给 LLM 提取 keyword 调工具（detection 只负责绕开 LLM 的那一类）。 */
export function detectDealsCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return DEAL_SIGNAL.test(t) || CHEAP_PRODUCT.test(t) || PRODUCT_QUERY.test(t)
}
