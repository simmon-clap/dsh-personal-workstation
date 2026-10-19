/** 设置页信息架构（W1 P0-1）的判据测试：G-SET-1…G-SET-8 的 jsdom 部分。
 *
 *  46 号审计实测：设置页 3.44 屏（手机 5.08 屏）、首屏只有底栏 2 个按钮、同一页三种「定时」说法。
 *  这里锁住新结构：首屏 = 授权 + 助理状态 + 一个动作；版本/留痕/帮助进折叠；
 *  定时只有 heartbeat_status 一个来源，全页只有「有定时 / 没定时 / 读不到」三态。
 *  首屏高度的**像素**判定在 `mobile-audit.mjs` 与 `semantic-gates.mjs`（真实浏览器），不在 jsdom。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {settingsHtml, applySettingsStatus, applySettingsTiming, timerLine, scanTimerContradiction, aboutHtml, createInbox} from '../prototype/inbox.mjs';

const shell = () => new JSDOM(readFileSync(new URL('../prototype/replica/index.html', import.meta.url), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (times = 30) => { for (let index = 0; index < times; index += 1) await tick(); };

const statusFixture = () => ({
  package: 'dsh-personal-workstation', version: '2.6.0',
  build: {builtAt: '2026-10-17T10:00:00.000Z', needsRestart: false},
  capabilities: {
    textFiles: {readGrants: 3, writeGrants: 2}, knowledge: {baseGrants: 1},
    officePreview: true, speechToText: true, speech: {providers: [{id: 's', name: 'SenseVoice', phase: 'standby'}]},
    execution: false, calendarSync: true, calendarSyncNote: '本机能力', integrations: {feishu: {configured: false, connected: false, reason: '未配置'}}
  }
});

test('G-SET-2：骨架首屏有授权、助理状态与唯一主色动作；授权面板默认收起', () => {
  const document = shell().window.document;
  document.querySelector('#detailbody').innerHTML = settingsHtml();
  const body = document.querySelector('#detailbody');
  assert(body.querySelector('[data-settings-firstscreen]'), '必须有首屏容器');
  assert(body.querySelector('[data-settings-manage="grants"]'), '首屏必须有授权管理动作');
  assert.equal(body.querySelector('#settingsheartbeat')?.dataset.settingsPrimary, 'heartbeat', '首屏必须有唯一主色动作');
  assert(body.querySelector('#grantsbody').hidden, '授权面板默认收起（首屏不为它付高度）');
  assert.equal(body.querySelectorAll('[data-settings-primary]').length, 1, '主色动作只能有一个');
  assert(body.querySelector('[data-settings-row="timing"]'), '定时行必须在首屏');
  assert(body.querySelector('[data-settings-row="folders"]') && body.querySelector('[data-settings-row="knowledge"]'), '文件夹与知识库都必须在首屏');
});

test('G-SET-6：版本/留痕/帮助都在折叠里，不在首屏容器内', () => {
  const document = shell().window.document;
  document.querySelector('#detailbody').innerHTML = settingsHtml();
  const body = document.querySelector('#detailbody');
  const first = body.querySelector('[data-settings-firstscreen]').textContent;
  assert.doesNotMatch(first, /版本与设计|纸上秩序|助理替你做过的|要追细节/, '版本/设计/留痕/帮助不得进首屏');
  for (const name of ['history', 'about', 'help']) assert(body.querySelector('[data-settings-details="' + name + '"]'), '缺折叠：' + name);
});

test('G-SET-3：定时只有一套话术（有 / 没有 / 读不到），不再三种口径并存', () => {
  assert.deepEqual(timerLine({scheduled: true, intervalMinutes: 60, lastSuccessAt: '2026-10-17T13:54:51.288Z', totalRuns: 14}).state, 'ok');
  assert.match(timerLine({scheduled: true, intervalMinutes: 60}).main, /已开启 · 每 60 分钟自己醒一次/);
  assert.match(timerLine({scheduled: false, intervalMinutes: 0}).main, /没有开启 · 要你点一下它才会看一眼/);
  assert.equal(timerLine(null).state, 'unknown');
  const oldThree = '定时与提醒 未接入 这台机器上没有接入定时服务。现在只能手动触发，还没有接入定时。已在定时运行 上次跑成 21:54';
  assert(scanTimerContradiction(oldThree).pairs >= 1, '旧的三套说法必须被判为矛盾（canary）');
  const fresh = timerLine({scheduled: true, intervalMinutes: 60}).main + timerLine({scheduled: true, intervalMinutes: 60}).note;
  assert.equal(scanTimerContradiction(fresh).pairs, 0, '新话术不得被判为矛盾');
});

test('G-SET-5：能力区只列接上的；没接上的收进折叠且每项有下一步', () => {
  const document = shell().window.document;
  const root = document.createElement('div'); document.body.append(root);
  root.innerHTML = settingsHtml();
  applySettingsStatus(root, statusFixture());
  const caps = root.querySelector('[data-settings-cell="caps"]').textContent;
  assert.match(caps, /读文件/);
  assert.match(caps, /看图片 \/ PDF/);
  assert.doesNotMatch(caps, /让机器执行任务/, '"已接上"只列已接上的能力');
  const off = root.querySelector('[data-settings-off="1"]');
  assert(off && !off.hidden, '没接上的能力必须折叠可见');
  assert.match(off.textContent, /让机器执行任务/);
  assert.match(off.textContent, /下一步/);
  assert.doesNotMatch(root.textContent, /未配置（在 DSH 的插件设置里填）/, '飞书不再走旧的"未配置"说法');
});

test('G-SET-7：读不到状态 → 写读不到 + 每块一个重试，不是空白也不是默认已接上', () => {
  const document = shell().window.document;
  const root = document.createElement('div'); document.body.append(root);
  root.innerHTML = settingsHtml();
  applySettingsStatus(root, null);
  applySettingsTiming(root, null);
  assert.match(root.querySelector('[data-settings-cell="folders"]').textContent, /读不到/);
  assert.match(root.querySelector('[data-settings-cell="timing"]').textContent, /读不到定时状态/);
  assert(root.querySelector('[data-settings-retry="status"]'), '失败必须能只重拉状态');
  assert(root.querySelector('[data-settings-retry="timing"]'), '失败必须能只重拉定时');
  assert.doesNotMatch(root.textContent, /已接上宿主|已配置/);
});

test('G-SET-4：打开设置不请求 schedule_list（心跳定时只走 heartbeat_status）', async () => {
  const dom = shell(), document = dom.window.document;
  const actions = [];
  const send = async (action, data) => {
    actions.push({action, data});
    if (action === 'runtime_status') return statusFixture();
    if (action === 'heartbeat_status') return {status: {scheduled: true, intervalMinutes: 60, lastSuccessAt: '2026-10-17T13:54:51.288Z', totalRuns: 14}};
    if (action === 'speak_status') throw Error('未接入');
    throw Error(action);
  };
  const inbox = createInbox(document, send, {draft: async () => ({}), open: () => {}, notify: () => {}});
  try {
    await inbox.openSettings(); await settle();
    assert(!actions.some(item => item.action === 'schedule_list'), '设置页不得再请求 schedule_list（那是实验包"自动化任务"，不是心跳定时）');
    assert.equal(actions.filter(item => item.action === 'heartbeat_status').length, 1, 'heartbeat_status 只请求一次');
    assert.equal(actions.filter(item => item.action === 'runtime_status').length, 1, 'runtime_status 只请求一次');
  } finally { inbox.dispose(); dom.window.close(); }
});

test('G-SET-11/12：关于里有版本/数据根/写入审批/登录，协作方式说人话', () => {
  const html = aboutHtml(statusFixture());
  assert.match(html, /dsh-personal-workstation 2\.6\.0/);
  assert.match(html, /数据放在哪/);
  assert.match(html, /AI 提的改动、画布位置：要你点同意才生效/);
  assert.match(html, /在浏览器中登录 DSH/);
  assert.doesNotMatch(html, /cordis\.patch\.yml|rootDirectory/, '关于里也不把配置字段名端给用户');
});

test('设置页文案不得出现内部术语（术语泄漏是全站性问题）', () => {
  const text = settingsHtml() + aboutHtml(statusFixture());
  for (const word of ['批次', '草稿', '回执', '幂等', '落库', '快照', '收录', '核验', '差异化']) {
    assert(!text.includes(word), '设置页出现内部术语：' + word);
  }
});
