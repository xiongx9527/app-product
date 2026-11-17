/**
 * 「找好价 / 便宜的 X」这类高置信好价意图的确定性识别：命中后绕开 LLM 直接调 dealsTool。
 *
 * 只拦好价信号明确的句子（打折、优惠、折扣、好价、便宜…），这些词本身就是优惠语境。
 * 纯「查询商品 / 搜索商品」不再在此拦——用户口径：只有说了优惠/打折/折扣才限定好价；
 * 纯商品查询交给 LLM 调工具走站内真搜索（tag 页），搜到的商品不限于是好价商品。
 *
 * 单独出现的泛词「东西 / 商品 / 买卖」不拦截（太泛），只写进工具 description 交给 LLM
 * 结合上下文判断。与音乐/音量/记忆等既有直连命令互斥：本检测放在 handleDirectCommand
 * 最后，其它命令都没命中才轮到它。
 */
const DEAL_SIGNAL = /打折|优惠|折扣|好价|特价|促销|秒杀|清仓|降价|划算|省钱|白菜价|史低/
const CHEAP_PRODUCT =
  /便宜.{0,6}(东西|商品|货|买|入手|有啥|有什么)|(东西|商品|货).{0,4}便宜|(有什么|来点|给点|推荐).{0,4}便宜/

/** 文本是否为「找好价/便宜货」的高置信好价意图。带具体商品名的句子不在此拦，
 *  交给 LLM 提取 keyword 调工具（detection 只负责绕开 LLM 的那一类）。 */
export function detectDealsCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return DEAL_SIGNAL.test(t) || CHEAP_PRODUCT.test(t)
}
