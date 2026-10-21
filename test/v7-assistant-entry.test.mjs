/** W1 P0-4「去 DSH 对话」入口的判据测试（D2-1/D2-4/D2-6 + canary）。
 *
 *  46 号审计：点「助理」只得到"这里不放输入框 + 复制一句开场白"，App 内没有任何下一步（死胡同）。
 *  用户已拍板 D2-a：同一位置改名「去 DSH 对话」，一次点击就能输入。
 *  真实浏览器上的 D2-2/D2-3（宿主 iframe → 新会话 → 输入框聚焦）在安装后跑 live-acceptance。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openDshChat} from '../prototype/v7-controller-v6.mjs';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('D2-1：入口文案 = 去 DSH 对话；说明书与"复制开场白"必须删干净', () => {
  const controller = source('../prototype/v7-controller-v6.mjs');
  assert.match(controller, /去 DSH 对话/, '按钮必须改成真动作的名字');
  assert.doesNotMatch(controller, /这里不放输入框/, '说明书弹窗必须删掉');
  assert.doesNotMatch(controller, /复制一句开场白/, '"复制粘贴"不能作为唯一动作');
  assert.doesNotMatch(controller, /assistantcopy/);
});

test('D2-6：不操作宿主 DOM（禁止 parent.document/top.document）', () => {
  for (const text of [source('../prototype/v7-controller-v6.mjs'), source('../client/client.js')]) {
    assert.doesNotMatch(text, /parent\.document|top\.document|window\.parent\.document/);
  }
});

test('客户端半：只用公开的 uiWorkspace.startSession()，且只在自家 iframe 上响应', () => {
  const client = source('../client/client.js');
  assert.match(client, /ctx\.inject\(\['uiWorkspace'(?:,'sessions')?\]/, 'uiWorkspace/sessions 必须是可选依赖（宿主没有时不装桥）');
  assert.match(client, /uiWorkspace\.startSession\(undefined/);
  assert.match(client, /prompt/);
  assert.match(client, /sessions\.retain/, '静默后台生成必须用 sessions 服务在后台起回合');
  assert.match(client, /binding\.session\.prompt/);
  assert.match(client, /workstation:open-chat/);
  assert.match(client, /workstation:open-chat-ack/);
  assert.match(client, /contentWindow===event\.source/, '必须只认自己那个 iframe');
});

const fakeWindow = ({embedded = true} = {}) => {
  const listeners = new Map();
  const sent = [];
  const assigned = [];
  const win = {
    parent: null,
    top: null,
    location: {origin: 'http://127.0.0.1:51199', assign: to => assigned.push(to)},
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    postMessage: (...args) => { throw Error('should not be called on self'); }
  };
  if (embedded) {
    win.parent = {postMessage: (message, origin) => sent.push({message, origin})};
    win.top = {location: {assign: to => assigned.push(to)}};
  } else {
    win.parent = win;
    win.top = win;
  }
  const ack = () => listeners.get('message')?.({origin: win.location.origin, data: {type: 'workstation:open-chat-ack'}});
  return {win, sent, assigned, ack, listeners};
};

test('D2-3（逻辑层）：嵌入态发消息 → 收到 ack 后不兜底跳走', async () => {
  const {win, sent, assigned, ack} = fakeWindow();
  openDshChat(win, {settleMs: 20});
  assert.deepEqual(sent, [{message: {type: 'workstation:open-chat'}, origin: 'http://127.0.0.1:51199'}]);

  ack();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(assigned, [], '宿主已 ack 就不能再兜底跳 /');
});

test('兜底：嵌入态 600ms 内没有 ack → 跳回 /（同源，输入框在首屏）', async () => {
  const {win, assigned} = fakeWindow();
  openDshChat(win, {settleMs: 20});
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(assigned, ['/'], '没有 ack 必须有一个可完成动作的下一步');
});

test('按钮化 AI：openDshChat 可携带 prompt，且不改变无 prompt 的旧行为', () => {
  const {win, sent, ack} = fakeWindow();
  openDshChat(win, {settleMs: 20, prompt: '为项目生成视图'});
  assert.deepEqual(sent, [{message: {type: 'workstation:open-chat', prompt: '为项目生成视图'}, origin: 'http://127.0.0.1:51199'}]);
  ack();
});

test('D2-4：独立页（不在 iframe 里）→ 同源跳到 /', () => {
  const {win, assigned} = fakeWindow({embedded: false});
  openDshChat(win, {settleMs: 20});
  assert.deepEqual(assigned, ['/']);
});

test('canary：若有人把入口改回"说明弹窗"，D2-1 会红', () => {
  const fake = '这里不放输入框' + '复制一句开场白';
  assert.throws(() => {
    assert.doesNotMatch(fake, /这里不放输入框/);
  }, '旧行为必须被这条判据拦住');
});
