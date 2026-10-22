import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composeOpeningMessage, deliverOpening} from '../src/deliver.mjs';

/** 投递层（spec/55 P4）的验收：
 *  - 没内容就不发（不许发"今天没事"这种噪音）；
 *  - 一条，不拆散；
 *  - 未接入 / 失败都要如实返回，不许假成功。 */

const opening = (items) => ({anchor: 'morning', items});

test('有内容：合成一条人话，三问都在里面', () => {
 const text = composeOpeningMessage(opening([
  {title: '交周报', changed: '交付日期 2026-10-22', means: '今天到期', verb: '打开这件事'},
 ]));
 assert.match(text, /^早上好/);
 assert.match(text, /1\. 交周报 —— 交付日期 2026-10-22，今天到期（打开这件事）/);
});

test('晚上开口用晚上的称呼', () => {
 const text = composeOpeningMessage({anchor: 'evening', items: [{title: 'x', changed: 'y', means: 'z', verb: '看看'}]});
 assert.match(text, /^晚上好/);
});

test('没有内容就不发：返回 null，调用方不许自己编一条"今天没事"', () => {
 assert.equal(composeOpeningMessage(opening([])), null);
 assert.equal(composeOpeningMessage(null), null);
});

test('多条合并成一条消息，不是发多条', () => {
 const text = composeOpeningMessage(opening([
  {title: 'A', changed: 'a1', means: 'a2', verb: '看'},
  {title: 'B', changed: 'b1', means: 'b2', verb: '看'},
 ]));
 assert.equal(text.split('\n').length, 3, '标题一行 + 两条');
});

test('IM 没接入：如实说没接入，不算成功', async () => {
 const result = await deliverOpening({imSend: null, opening: opening([{title: 'A', changed: 'a', means: 'b', verb: '看'}])});
 assert.equal(result.sent, false);
 assert.match(result.reason, /没接上/);
});

test('发送失败：把原因带回来，不吞掉', async () => {
 const result = await deliverOpening({
  imSend: {sendToLatest: async () => { throw new Error('渠道未连接：feishu'); }},
  opening: opening([{title: 'A', changed: 'a', means: 'b', verb: '看'}]),
 });
 assert.equal(result.sent, false);
 assert.match(result.reason, /渠道未连接/);
});

test('发送成功：把渠道与会话带回来', async () => {
 const result = await deliverOpening({
  imSend: {sendToLatest: async () => ({channel: 'feishu', chatId: 'oc_1'})},
  opening: opening([{title: 'A', changed: 'a', means: 'b', verb: '看'}]),
 });
 assert.equal(result.sent, true);
 assert.equal(result.chatId, 'oc_1');
});
