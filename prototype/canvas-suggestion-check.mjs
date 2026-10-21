#!/usr/bin/env node
/** 画布上的「AI 推断关系」验收（真浏览器 + 一次性内存库）。
 *
 *  用户 2026-10-16 的原话：「AI 推断的关系必须**虚线 + 可点否决**，前提是现有推断，
 *  **现在是连虚线都没有**」。
 *
 *  这个检查盯的就是那三件事，一件都不含糊：
 *    ① 待决定的推断**画得出来**（虚线），而不是"先同意才看得见"；
 *    ② 点得开，且说清"这是 AI 提的、还没生效"；
 *    ③ 同意 → 变成正式关联；不用了 → 不再出现。
 *
 *  用法：node prototype/canvas-suggestion-check.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

// 两个真实形状的对象 + 一条**待决定的**关系建议（就是 AI 跑推断之后落到收件箱的东西）。
const seed = store.draft(ctx, {
  title: '画布推断验收数据',
  changes: [
    {op: 'create', id: 'ev-1', kind: 'event', data: {title: '与示例客户董事长会面', startDate: '2026-10-12T18:00:00+08:00', endDate: '2026-10-12T19:00:00+08:00', eventType: 'meeting'}},
    {op: 'create', id: 'pr-1', kind: 'project', data: {title: '示例客户体外：水利大模型公司', stage: '接触'}},
  ],
});
store.commit(ctx, {batchId: seed.id, revision: seed.revision, key: 'seed-canvas'});
const suggestion = store.draft(ctx, {
  title: '关联待确认：同一件事',
  changes: [{op: 'create', id: 'rel-1', kind: 'relation', data: {
    title: '同一件事', from: 'ev-1', to: 'pr-1', status: 'confirmed',
    evidence: '这场见面谈的就是这个项目（都提到「燃气大模型公司」）',
    reason: '这场见面谈的就是这个项目', basis: ['ev-1@1', 'pr-1@1'],
  }}],
  proposal: {
    evidence: [{kind: 'note', ref: 'rel-1', quote: '这场见面谈的就是这个项目', verified: false}],
    uncertainty: '关系来自数据里已有的共同信号，不是推断结论。',
  },
  source: {kind: 'advice', rule: 'relation-candidate', subjectId: 'ev-1'},
});

const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: id => (id === 'w' ? {id: 'w'} : null)},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
await page.setViewport({width: 1440, height: 940});
const problems = [];
const pageErrors = [];
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? '  → ' + extra : ''));
  if (!ok) problems.push(label);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
  await wait(800);
  await page.evaluate(() => document.querySelector('.nav [data-view="space"]')?.click());
  await wait(2000);
  // 画布默认范围已改为「按分类」结构态（spec/54 §2 / D8）：关系与 AI 建议在「全部关系」范围里看。
  // 这一步同时也在验证「切范围不换页」——URL 没变、页面没重建，只是同一张画布换了范围。
  await page.evaluate(() => { const scope = document.querySelector('#scopefilter'); if (scope) { scope.value = 'all'; scope.onchange(); } });
  await wait(1200);

  // ① 待决定的推断要画成虚线
  const dashed = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('#spaceSvg path[stroke]')];
    return paths.filter(p => (p.getAttribute('stroke-dasharray') || 'none') !== 'none')
      .map(p => p.closest('g')?.getAttribute('aria-label') ?? '');
  });
  check('待决定的推断在画布上画出来了（虚线）', dashed.length > 0, dashed.slice(0, 2).join(' | '));
  // VI §8 V1：AI 推的 = 紫 + 虚线 + **「AI 判断」文字**，三样齐全（颜色不得单独承担判断）。
  check('AI 推断的关系带「AI 判断」文字（VI §8 V1）', dashed.some(label => label.includes('AI 判断')), dashed.slice(0, 2).join(' | '));

  // ② 点得开，且说清"这是 AI 提的、还没生效"
  // 真实鼠标点击（应用按坐标命中连线，合成事件没有坐标会点空）。
  const box = await page.evaluate(() => {
    const path = [...document.querySelectorAll('#spaceSvg path[stroke]')]
      .find(p => (p.getAttribute('stroke-dasharray') || 'none') !== 'none');
    if (!path) return null;
    const rect = path.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, id: path.closest('g[data-edge]')?.dataset.edge ?? null};
  });
  const opened = box?.id ?? null;
  if (box) await page.mouse.click(box.x, box.y);
  check('虚线点得开', Boolean(opened), String(opened));
  await wait(600);
  // CV-08（spec/53 §3.3 / PRD CV-08）：点虚线先出**画布内操作条**，不是强制弹窗；
  // 四个动作：看依据 / 同意 / 不同意 / 稍后。「看依据」才打开居中弹窗。
  const barText = await page.evaluate(() => document.querySelector('#canvasactionbar')?.innerText ?? '');
  check('点开后说清这是 AI 提议、还没生效', barText.includes('AI 提议') && barText.includes('还没生效'), barText.slice(0, 70).replace(/\n/g, ' '));
  check('给出「同意」动作', barText.includes('同意'), '');
  check('给出「不同意」与「稍后」', barText.includes('不同意') && barText.includes('稍后'), '');
  check('不强制弹窗（先出操作条）', await page.evaluate(() => !document.querySelector('#veil')?.classList.contains('open')), '');

  // ③ 同意 → 变成正式关联（虚线变实线），收件箱里那条不再是待决定
  await page.evaluate(() => {
    document.querySelector('#canvasactionbar [data-edge-action="accept"]')?.click();
  });
  await wait(1500);
  const after = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('#spaceSvg path[stroke]')];
    return {dashed: paths.filter(p => (p.getAttribute('stroke-dasharray') || 'none') !== 'none').length, total: paths.length};
  });
  const committed = store.get(ctx, 'rel-1');
  check('同意之后关联真的生效（对象已存在）', Boolean(committed) && committed.data.status === 'confirmed', JSON.stringify(committed?.data?.status ?? null));
  check('同意之后画布上不再有那条虚线', after.dashed === 0, '虚线 ' + after.dashed + ' / 连线 ' + after.total);
  const pending = store.inbox(ctx, {status: 'draft'}).filter(b => b.id === suggestion.id);
  check('同意之后收件箱里那条不再是待决定', pending.length === 0, '');

  // ── VI §9 缩放分层（强制，2026-10-16 补）───────────────────────────────────
  // 规范：<60% 名称+类型 · 60–110% 补状态与计数 · >110% 才显示关系文字。
  // 实测的 bug：这些内容在 draw() 时按当时的 zoom 算一次，而**所有缩放入口只调 transform()、不重绘** ——
  // 于是缩到 250% 也不会有关系文字、缩到 25% 也不会隐藏副标题。
  // 这里不看函数返回值（那只能证明"函数是对的"），而是**真的按缩放按钮，再读页面上渲染出来的东西**。
  // 先放大，**记住那个"有计数可显示"的项目/任务节点**，之后缩回去查同一个节点 ——
  // 第一版是每次重新挑节点，缩小时挑到副标题为空的那个，于是"只显示类型"这条**空着也通过**（假绿）。
  const zoomIn0 = async times => { for (let i = 0; i < times; i += 1) { await page.evaluate(() => document.querySelector('#more')?.click()); await new Promise(r => setTimeout(r, 140)); } };
  await zoomIn0(9);
  const countedNode = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#spaceSvg [data-node]')];
    // 选一个「有状态可显示」的项目/任务节点（0/0 已经如实写成「尚无交付项/尚无步骤」，
    // 所以不能再靠 "N/N 项" 这个文本来挑节点 —— 那正是 S4 要求删掉的写法）。
    const usable = groups.filter(group => ['project', 'task'].includes(group.dataset.kind));
    return usable[0]?.dataset.node ?? groups[0]?.dataset.node ?? null;
  });
  const zoomState = async nodeId => page.evaluate(id => {
    const world = document.querySelector('#spaceworld');
    const match = /scale\(([\d.]+)\)/.exec(world?.getAttribute('transform') || '');
    const zoom = match ? Number(match[1]) : null;
    const edges = [...document.querySelectorAll('#spaceSvg g[data-edge]')];
    const labelled = edges.filter(group => group.querySelector('.graphlabel')).length;
    // 挑一个"有状态可显示"的节点（项目/任务），否则副标题本来就等于类型名，量不出分层
    const node = id ? document.querySelector('#spaceSvg [data-node="' + id + '"]') : null;
    const lines = [...(node?.querySelectorAll('text') ?? [])].map(t => (t.textContent || '').trim()).filter(Boolean);
    // 副标题 = 非标题的那一行（标题在 y=33，副标题在 y=60/72）
    const subtitle = lines[lines.length - 1] ?? '';
    return {zoom, edges: edges.length, labelled, subtitle, nodeFound: Boolean(node)};
  }, nodeId);
  const zoomOut = async () => { for (let i = 0; i < 9; i += 1) { await page.evaluate(() => document.querySelector('#less')?.click()); await new Promise(r => setTimeout(r, 120)); } };
  const zoomIn = async times => { for (let i = 0; i < times; i += 1) { await page.evaluate(() => document.querySelector('#more')?.click()); await new Promise(r => setTimeout(r, 140)); } };

  await zoomOut();
  const small = await zoomState(countedNode);
  check('缩到 <60% 时不显示关系文字（VI §9）', small.labelled === 0, 'zoom=' + small.zoom?.toFixed(2) + ' · 关系文字 ' + small.labelled + '/' + small.edges);
  // 必须**真的有内容**且只有类型：空串不算通过（第一版就是被空串骗过去的）。
  check('缩到 <60% 时副标题只显示类型（非空、且不显示计数）',
    small.nodeFound && small.subtitle.length > 0 && !/项 ·/.test(small.subtitle),
    '节点 ' + countedNode + ' 副标题「' + small.subtitle + '」');

  await zoomIn(11);
  const big = await zoomState(countedNode);
  check('放大到 >110% 才出现关系文字（VI §9）', big.labelled > 0, 'zoom=' + big.zoom?.toFixed(2) + ' · 关系文字 ' + big.labelled + '/' + big.edges);
  check('放大后副标题补上状态与计数（VI §9）', /项 ·/.test(big.subtitle), '副标题「' + big.subtitle + '」');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

console.log('────────────────────────────────────────────────────────');
console.log(problems.length ? 'FAIL: ' + problems.length + ' 项未通过' : 'PASS: 画布推断的「虚线 → 看得见 → 点得动 → 同意即生效」全部成立。');
process.exit(problems.length ? 1 : 0);
