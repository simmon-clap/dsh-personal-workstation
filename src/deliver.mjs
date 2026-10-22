/** 开口的投递：把判断层挑出来的那几条，变成一条能发到 IM 里的人话（spec/55 P4）。
 *
 *  ## 为什么单独一层
 *  判断层是纯函数（可回测、可计数）；投递是有副作用的（真的会响你手机）。
 *  分开之后，"说了什么"可以在没有通道的机器上验，"发没发出去"只在有通道时发生。
 *
 *  ## 三条硬规则（都来自宪章）
 *  1. **没内容就不发**：items 为空时返回 null，调用方不得发一条"今天没事"——那是噪音。
 *  2. **发不出去要说出来**：未接入 / 发送失败都返回 `{sent:false, reason}`，
 *     绝不返回假成功（17 C8）。失败原因会进留痕，界面照旧能看到这条开口。
 *  3. **一条，不拆散**：合并成一条消息（03 §6 ④「合并，不零散」）。一开口就三五条弹窗，
 *     用户第一周就会静音。
 */

/** 把一次开口写成一条人话消息。没有条目就返回 null。 */
export function composeOpeningMessage(opening) {
 const items = Array.isArray(opening?.items) ? opening.items : [];
 if (!items.length) return null;
 const head = opening?.anchor === 'morning' ? '早上好' : '晚上好';
 const lines = items.map((item, index) => {
  const n = index + 1;
  // 三问里已经带了「变了什么」和「意味着什么」；动作放在最后一句，避免一堆祈使句。
  return n + '. ' + item.title + ' —— ' + item.changed + '，' + item.means + '（' + item.verb + '）';
 });
 return head + '。有 ' + items.length + ' 件事值得你看一眼：\n' + lines.join('\n');
}

/**
 * 发出去。通道可能是 Cordis 服务 `imSend`，也可能是 null（没有 IM 插件/没连上）。
 * @returns {{sent:boolean, reason?:string, channel?:string, chatId?:string}}
 */
export async function deliverOpening({imSend = null, opening, logger = null} = {}) {
 const text = composeOpeningMessage(opening);
 if (!text) return {sent: false, reason: '这次没有值得说的，不打扰'};
 if (!imSend || typeof imSend.sendToLatest !== 'function') {
  return {sent: false, reason: 'IM 主动发送没接上（宿主没提供 imSend 服务）'};
 }
 try {
  const result = await imSend.sendToLatest(text);
  logger?.('opening_delivered', {anchor: opening?.anchor, channel: result?.channel ?? null});
  return {sent: true, channel: result?.channel ?? null, chatId: result?.chatId ?? null};
 } catch (error) {
  const reason = String(error?.message ?? error).slice(0, 200);
  logger?.('opening_delivery_failed', {anchor: opening?.anchor, reason});
  return {sent: false, reason};
 }
}
