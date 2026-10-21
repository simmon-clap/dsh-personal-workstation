import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {
 createGeneratedView,
 renderView,
 renderViewState,
 renderLoading,
 validateView,
 viewProvenance,
 basisItemId,
} from '../prototype/generated-view-v2.mjs';

const dom = () => new JSDOM('<!doctype html><html><body></body></html>');
const basis = [
 {kind: 'judgment', ref: 'j-1@3', quote: '试点数据只覆盖一个场景'},
 {kind: 'file', ref: '会议纪要.md@2', quote: '成本口径待确认'},
];
const riskView = {
 kind: 'view',
 title: '联合验证 · 风险与证据',
 template: 'risk-matrix',
 subject: {id: 'p-a', kind: 'project', revision: 7},
 params: {horizonDays: 90},
 dataRefs: ['p-a@7', 'j-1@3'],
 basis,
 generatedAt: '2026-10-18T13:40:00',
 origin: 'ai',
 state: 'fresh',
 actions: ['open-subject', 'save-as-judgment', 'save-as-brief'],
 content: {
  columns: [{id: 'risk', label: '风险'}, {id: 'evidence', label: '证据强度'}, {id: 'basis', label: '依据'}],
  rows: [{id: 't-1', kind: 'task', title: '伙伴背景研究', risk: 'high', riskLabel: '高', evidenceStrength: 'weak', evidenceLabel: '弱', evidenceCount: 1, verifiedCount: 0, reason: '来源为对方自述', refs: ['j-1@3']}],
  counts: {high: 1, medium: 0, low: 0, total: 1},
 },
};
const timelineView = {
 kind: 'view', title: '时间线', template: 'timeline', subject: {id: 'p-a', kind: 'project', revision: 1},
 basis, generatedAt: '2026-10-18T09:05:00+08:00', origin: 'ai', state: 'fresh', actions: ['open-subject', 'save-as-judgment'],
 content: {
  range: {from: '2026-09-01', to: '2026-11-15'},
  items: [
   {id: 'a0', kind: 'deliverable', title: '方案评审', at: '2026-09-12', state: 'done', stateLabel: '已完成', waiting: false, waitingOn: null, reason: null, refs: ['p-a@1']},
   {id: 't-2', kind: 'task', title: '试点方案整理', at: '2026-10-20', state: 'waiting', stateLabel: '等待中', waiting: true, waitingOn: {id: 'o-b', title: '伙伴 B', kind: 'organization'}, reason: '等对方给部署边界', refs: []},
  ],
 },
};
const compareView = {
 kind: 'view', title: '材料对比', template: 'compare-table', subject: null, params: {subjectIds: ['j-1', 'j-2']},
 basis, generatedAt: '2026-10-18T10:00:00+08:00', origin: 'ai', state: 'fresh', actions: ['save-as-judgment'],
 content: {
  sources: [{id: 'j-1', kind: 'judgment', title: '延迟口径', revision: 2, ref: 'j-1@2'}, {id: 'a-1', kind: 'artifact', title: '推理评测方法', revision: 1, ref: 'a-1@1'}],
  dimensions: [{id: 'latency', label: '延迟口径'}],
  matrix: [{id: 'latency', label: '延迟口径', cells: [{value: 'P95 120ms', status: 'same', ref: 'j-1@2', field: 'content'}, {value: null, status: 'missing', ref: 'a-1@1', field: 'content'}]}, {id: 'cost', label: '成本口径', cells: [{value: '按卡计', status: 'diff', ref: 'j-1@2', field: 'content'}, {value: '按小时计', status: 'diff', ref: 'a-1@1', field: 'content'}]}],
  agreement: {same: 1, diff: 2, missing: 1, unrated: 0},
 },
};
const blockerView = {
 kind: 'view', title: '阻塞说明', template: 'blocker', subject: {id: 't-2', kind: 'task', revision: 4},
 basis: [{kind: 'note', ref: 't-2@4', quote: '等对方给部署边界'}], generatedAt: '2026-10-18T11:30:00+08:00', origin: 'ai', state: 'fresh', actions: ['open-subject', 'save-as-judgment'],
 content: {
  task: {id: 't-2', title: '试点方案整理', revision: 4, status: 'waiting', statusLabel: '等待中', blockedReason: '等伙伴 B 回复部署边界', dueDate: '2026-10-25', owner: {id: 'p-1', title: '我'}},
  chain: [{id: 't-2', kind: 'task', title: '试点方案整理', state: 'waiting', stateLabel: '等待', reason: '等部署边界', ref: 't-2@4'}],
  waitingOn: [{id: 'o-b', kind: 'organization', title: '伙伴 B', ref: 'o-b@1'}],
  nextSteps: [{label: '周三前发一封确认邮件', reason: '会议纪要里承诺过', refs: ['e-1@1']}, {label: '补充成本口径', reason: '对比表里缺这一项', refs: []}, {label: '更新交付日期', reason: '按最新边界重排', refs: []}],
 },
};

test('出处条按 18 §4 的口径说话：AI 生成 · 依据 N 条 · 数据截至 YYYY-MM-DD HH:MM', () => {
 const provenance = viewProvenance(riskView);
 assert.equal(provenance.origin, 'AI 生成');
 assert.equal(provenance.count, 2);
 assert.equal(provenance.at, '2026-10-18 13:40');
 assert.match(provenance.text, /^AI 生成 · 依据 2 条 · 数据截至 2026-10-18 13:40$/);
 assert.equal(viewProvenance({origin: null, basis: [], generatedAt: null}).text, '来源未记录 · 依据 0 条 · 数据截至 时间未记录');
});

test('risk-matrix：按服务端列渲染，数字只来自 view.content', () => {
 const {window} = dom();
 const {element, empty} = renderView(window.document, riskView, {onOpenSubject() {}});
 assert.equal(empty, false);
 const doc = window.document;
 assert.ok(element.querySelector('.gv-viewtitle').textContent.includes('风险与证据'));
 assert.ok(element.querySelector('.gv-table'));
 const text = element.textContent;
 assert.match(text, /伙伴背景研究/);
 assert.match(text, /高/);
 assert.match(text, /弱 · 1 条依据 · 已核对 0 条/);
 assert.match(text, /1 条依据/);
 assert.match(text, /高[\s\S]*1 项风险/); // counts 只显示真实数字
 assert.ok(element.querySelector('.gv-basissummary'));
 assert.equal(element.querySelector('.gv-basissummary').textContent, '依据 2 条');
});

test('basis 与 open-subject 都点得回真实对象；文件路径不假装能打开', () => {
 const {window} = dom();
 const opened = [];
 const basisOpened = [];
 const {element} = renderView(window.document, riskView, {
  onOpenSubject: id => opened.push(id),
  onOpenBasis: item => basisOpened.push(item),
 });
 for (const button of element.querySelectorAll('.gv-basisopen')) button.click();
 assert.deepEqual(basisOpened, [{kind: 'judgment', ref: 'j-1@3', quote: '试点数据只覆盖一个场景', id: 'j-1'}]);
 const openButton = [...element.querySelectorAll('.gv-action')].find(button => button.textContent === '打开原对象');
 openButton.click();
 assert.deepEqual(opened, ['p-a']);
 assert.equal(basisItemId('会议纪要.md@2'), null);
 assert.equal(basisItemId('p-a@7'), 'p-a');
});

test('timeline / compare-table / blocker 三个模板的字段都按真实结构渲染', () => {
 const timelineDom = dom();
 const timeline = renderView(timelineDom.window.document, timelineView, {}).element;
 assert.ok(timeline.querySelector('.gv-timeline'));
 assert.match(timeline.textContent, /方案评审/);
 assert.match(timeline.textContent, /等待中/);
 assert.match(timeline.textContent, /在等：伙伴 B/);
 assert.match(timeline.textContent, /范围 2026-09-01 → 2026-11-15/);

 const compareDom = dom();
 const compare = renderView(compareDom.window.document, compareView, {}).element;
 assert.match(compare.textContent, /延迟口径/);
 assert.match(compare.textContent, /分歧/);
 assert.match(compare.textContent, /一致 1 处 · 分歧 2 处 · 未记录 1 处/);
 assert.equal([...compare.querySelectorAll('.gv-th')].filter(th => th.textContent.includes('推理评测方法')).length, 1);

 const blockerDom = dom();
 const blocker = renderView(blockerDom.window.document, blockerView, {}).element;
 assert.match(blocker.textContent, /卡在哪/);
 assert.match(blocker.textContent, /在等谁/);
 assert.match(blocker.textContent, /下一步/);
 assert.match(blocker.textContent, /等伙伴 B 回复部署边界/);
 assert.equal(blocker.querySelectorAll('.gv-step').length, 2); // 下一步最多 3 条：第一条进「下一步」格，其余 2 条列出
 const blockerActions = [...blocker.querySelectorAll('.gv-action')].filter(button => button.textContent.startsWith('存为'));
 assert.ok(blockerActions.length <= 2);
});

test('渲染前校验：未登记模板直接拒绝，越界 dataRefs 拒绝，不降级', () => {
 assert.equal(validateView({...riskView, template: 'free-html'}).ok, false);
 const {window} = dom();
 const refused = renderView(window.document, {...riskView, template: 'free-html'}, {}).element;
 assert.equal(refused.querySelector('.gv-state').dataset.state, 'refused');
 assert.match(refused.textContent, /不在 v1 白名单里/);
 assert.equal(renderView(window.document, {...riskView, dataRefs: Array.from({length: 51}, (_, index) => `x-${index}@1`)}, {}).element.querySelector('.gv-state').dataset.state, 'refused');
 assert.equal(renderView(window.document, null, {}).element.querySelector('.gv-state').dataset.state, 'refused');
});

test('四态齐全：加载是静态骨架；空/失败/未接入都有一句人话 + 可点下一步', async () => {
 const {window} = dom();
 const doc = window.document;
 const loading = renderLoading(doc);
 assert.equal(loading.dataset.state, 'loading');
 assert.equal(loading.querySelectorAll('.gv-skel').length, 3);
 assert.match(loading.textContent, /正在生成分析/);

 let ran = 0;
 const empty = renderViewState(doc, {state: 'empty', title: '还没有可对比的记录', note: '先补一条判断', actionLabel: '去补判断', onAction: () => ran++});
 empty.querySelector('.gv-state-action').click();
 assert.equal(ran, 1);
 assert.equal(empty.getAttribute('role'), 'status');
 assert.equal(renderViewState(doc, {state: 'error', title: '生成分析时出错了'}).getAttribute('role'), 'alert');

 // 失败→重试；未接入→如实说明（不假装成功）
 let attempts = 0;
 const sent = [];
 const view = createGeneratedView(doc, async (action, data) => {
  sent.push([action, data]);
  attempts += 1;
  if (attempts === 1) throw Error('工作台请求失败（HTTP 503）');
  return {view: riskView};
 }, {});
 const entry = view.block({subjectId: 'p-a', heading: 'AI 分析', templates: [{id: 'risk-matrix', label: '生成风险与证据', params: {horizonDays: 90}}]});
 doc.body.append(entry.element);
 assert.equal(entry.element.querySelector('.gv-preview').hidden, true);
 await entry.generate('risk-matrix');
 assert.equal(entry.element.querySelector('.gv-state').dataset.state, 'error');
 assert.match(entry.element.textContent, /生成分析时出错了/);
 entry.element.querySelector('.gv-state-action').click();
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.equal(sent.length, 2);
 assert.ok(entry.element.querySelector('.gv-view'));
 assert.deepEqual(sent[0], ['view_preview', {template: 'risk-matrix', subjectId: 'p-a', params: {horizonDays: 90}}]);
});

test('未接入：错误码 UNKNOWN_ACTION 时显示未接入并保留重试，不伪造数据', async () => {
 const {window} = dom();
 const doc = window.document;
 const error = Error('未知动作：view_preview');
 error.code = 'UNKNOWN_ACTION';
 const view = createGeneratedView(doc, async () => { throw error; }, {});
 const entry = view.block({subjectId: 'p-a', templates: [{id: 'risk-matrix', label: '生成风险与证据'}]});
 doc.body.append(entry.element);
 await entry.generate('risk-matrix');
 const state = entry.element.querySelector('.gv-state');
 assert.equal(state.dataset.state, 'unwired');
 assert.match(state.textContent, /生成视图还没接上/);
 assert.ok(entry.element.querySelector('.gv-state-action').textContent.includes('重试'));
});

test('empty 空态说清缺什么 + 下一步；没有依据的视图不能保存', () => {
 const {window} = dom();
 const doc = window.document;
 const emptyView = {...riskView, content: {columns: [], rows: [], counts: {high: 0, medium: 0, low: 0, total: 0}}};
 const result = renderView(doc, emptyView, {});
 assert.equal(result.empty, true);
 assert.match(result.element.textContent, /还没有可分析的风险依据/);
 assert.equal(result.element.querySelectorAll('.gv-action').length, 0); // 空内容不给保存/打开动作

 const noBasis = renderView(doc, {...riskView, basis: []}, {});
 assert.match(noBasis.element.textContent, /依据 0 条/);
 assert.match(noBasis.element.textContent, /没有依据的视图只是一次性预览/);
 assert.equal([...noBasis.element.querySelectorAll('.gv-action')].filter(button => button.textContent.startsWith('存为')).length, 0);
});

test('stale 显示「依据已变，需复核」，重新生成是显式动作', () => {
 const {window} = dom();
 let regenerated = 0;
 const {element} = renderView(window.document, {...riskView, state: 'stale'}, {onRegenerate: () => regenerated++});
 assert.match(element.querySelector('.gv-stale').textContent, /依据已变，需复核/);
 element.querySelector('.gv-staleaction').click();
 assert.equal(regenerated, 1);
});

test('保存不直接写库：只发 view_save{view,as}，随后打开既有 batch 审核', async () => {
 const {window} = dom();
 const doc = window.document;
 const calls = [];
 const batches = [];
 const notes = [];
 const view = createGeneratedView(window.document, async (action, data) => {
  calls.push([action, data]);
  if (action === 'view_preview') return {view: riskView};
  if (action === 'view_save') return {batch: {id: 'b-1'}, as: data.as};
  throw Error('unexpected ' + action);
 }, {openBatch: id => batches.push(id), notify: message => notes.push(message)});
 const entry = view.block({subjectId: 'p-a', templates: [{id: 'risk-matrix', label: '生成风险与证据'}]});
 doc.body.append(entry.element);
 await entry.generate('risk-matrix');
 const save = [...entry.element.querySelectorAll('.gv-action')].find(button => button.textContent === '存为判断');
 save.click();
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.deepEqual(calls.filter(([action]) => action === 'view_save').map(([, data]) => data.as), ['judgment']);
 assert.deepEqual(batches, ['b-1']);
 assert.ok(notes.some(note => note.includes('待确认')));
});

test('保存失败给人话并允许重试（按钮恢复可用，界面不留假成功）', async () => {
 const {window} = dom();
 const doc = window.document;
 let fail = true;
 const view = createGeneratedView(doc, async (action) => {
  if (action === 'view_preview') return {view: riskView};
  if (fail) throw Error('网络中断，重试是安全的');
  return {batch: {id: 'b-2'}};
 }, {});
 const entry = view.block({subjectId: 'p-a', templates: [{id: 'risk-matrix', label: '生成风险与证据'}]});
 doc.body.append(entry.element);
 await entry.generate('risk-matrix');
 const save = [...entry.element.querySelectorAll('.gv-action')].find(button => button.textContent === '存为判断');
 save.click();
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.match(entry.element.querySelector('[data-gv-saveerror]').textContent, /没能保存：网络中断，重试是安全的。可以再点一次。/);
 assert.equal(save.disabled, false);
 fail = false;
 save.click();
 await new Promise(resolve => setTimeout(resolve, 0));
});

test('渲染器不拼 HTML：源码没有 innerHTML，恶意标题按文本显示', () => {
 const source = readFileSync(new URL('../prototype/generated-view-v2.mjs', import.meta.url), 'utf8');
 assert.doesNotMatch(source, /\.innerHTML/);
 const {window} = dom();
 const {element} = renderView(window.document, {...riskView, title: '<img src=x onerror=alert(1)>'}, {});
 assert.equal(element.querySelector('img'), null);
 assert.match(element.textContent, /<img src=x onerror=alert\(1\)>/);
});
