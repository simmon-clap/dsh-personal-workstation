#!/usr/bin/env node
/** 宪章 · 交互门禁（charter-ux-audit）：把《顶层宪章》《功能与交互设计》《VI 规范》里
 *  **人一眼能看出、机器也能验**的判据逐条跑一遍。
 *
 *  为什么还要一个脚本：`interaction-audit.mjs` 只覆盖 4 项（死路 / 多余确认 / 机器话 / 无去处），
 *  `craft/type-scale/css-var/mobile/user-view` 覆盖排版与规范。剩下的宪章条款——确认强度分级、
 *  就地钻取、一个视图一个主动作、状态可回原因、未接入不伪造、颜色不单独承担判断、点击即响应——
 *  **从来没有机器判据**，只能靠人肉看。这份脚本就是补这一段。
 *
 *  判据来源（逐条引用，不自行发明）：
 *    · spec/01-顶层宪章-v1.0.md        第五条（确认强度分级）· 第六条 诚实/克制/有重量 · 第七条 可读
 *    · spec/03-功能与交互设计-v1.0.md  §2 交互律 01/03/04/05/06 · §3 丝滑（零跳页/零等待感/随时可退）
 *                                      · §4 状态语言六种 · §5 不打断清单
 *    · spec/02-VI规范-v1.0.md          §7 状态与反馈语言 · §9 判断三要素 · §13 门禁 11 · §14 V2 V4 V8
 *
 *  安全：内存库 + 演示数据（`seedVisualStore`），**绝不读也不写生产库**。
 *  用法：node prototype/charter-ux-audit.mjs [--keep-screens]
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const shots = fileURLToPath(new URL('./screenshots/charter-ux/', import.meta.url));
mkdirSync(shots, {recursive: true});

// ── 夹具：内存库 + 演示数据 + 三类真实形状（待确认改动 / 待核对判断 / AI 提议）──
const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
const ctx = {workspace: 'w', actor: 'charter-ux-audit', canWrite: true};

/** 一条待你决定的改动（人为发起，用于验证"同意"路径与点击步数）。 */
const humanBatch = store.draft(ctx, {
  title: '会前材料归档',
  changes: [
    {op: 'create', id: 'a-new', kind: 'artifact', data: {title: '会前材料', path: 'notes/a.md', description: '要点'}},
    {op: 'update', id: 'p-a', expectedRevision: 1, data: {title: '联合验证', stage: '方案'}},
  ],
});

/** 一条待核对判断：状态 checking，带依据 + 不确定性（VI V2 三要素）。 */
const judgmentBatch = store.draft(ctx, {
  title: '对方口径的性能提升待确认',
  changes: [{
    op: 'create', id: 'j-1', kind: 'judgment',
    data: {
      title: '对方口径的性能提升待确认',
      uncertainty: '性能与成本为对方自述，未经第三方验证',
      validFrom: '2026-10-01',
      status: 'checking',
      evidence: [{kind: 'message', ref: 'msg-1', quote: '对方在 10-12 会上说提升三倍', verified: false}],
    },
  }],
});
store.commit(ctx, {batchId: judgmentBatch.id, revision: 1, key: 'charter-ux-judgment'});

/** 第二条待核对判断：专门留给「判断三要素」这一项。
 *  A3a/A3a2 会把第一条归档/删除，检查之间不能互相踩。 */
const judgmentFixture = store.draft(ctx, {
  title: '三要素夹具判断',
  changes: [{
    op: 'create', id: 'j-2', kind: 'judgment',
    data: {
      title: '三要素夹具判断',
      uncertainty: '这条数字来自对方自述，未经第三方验证',
      validFrom: '2026-10-02',
      status: 'checking',
      evidence: [{kind: 'message', ref: 'msg-9', quote: '对方说成本能压到一半', verified: false}],
    },
  }],
});
store.commit(ctx, {batchId: judgmentFixture.id, revision: 1, key: 'charter-ux-judgment-fixture'});

/** 收件箱里必须一直有一条待确认的改动：
 *  A3b 会把之前的草稿全部同意/取消掉，后面的检查（点击钻取、数字可点性）就无卡可点，
 *  门禁会变成"空跑通过/空跑失败"。每一段需要卡片的地方都先补一条。 */
let redraftSeed = 0;
const ensurePendingChange = title => {
  store.draft(ctx, {
    title: title ?? ('体检用待确认改动 ' + (redraftSeed += 1)),
    changes: [{op: 'create', id: 'a-redraft-' + redraftSeed, kind: 'artifact', data: {title: '体检用资料 ' + redraftSeed, path: 'notes/redraft.md', description: '用于门禁取样'}}],
  });
};

/** 一条 AI 提议（带 basedOn，用于验证「为什么这么建议」原地展开）。 */
const proposalBatch = store.draft(ctx, {
  title: '建议把评测方法复用给云服务合作',
  proposal: {
    evidence: [{kind: 'file', ref: 'a-1', quote: '推理评测方法固定了硬件与模型版本', verified: false}],
    uncertainty: '延迟口径未经第三方验证',
    basedOn: ['a-1'],
    decision: 'undecided',
  },
  changes: [{op: 'update', id: 'p-b', expectedRevision: 1, data: {title: '云服务合作', stage: '验证'}}],
});

const connection = {admit: () => ({peer: {id: 'charter-ux-audit'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
  files: {grants: [{id: 'voice-inbox', workspace: 'w', root: process.cwd(), read: true, write: false, label: '语音目录（只读）'}]},
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/personal-workstation';

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 1000});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 等界面稳定：轮询 DOM 变化，反馈一到就继续；最多等 ms。
 *  固定 sleep 既慢又不稳，改用这个之后大多数步骤在 100–300ms 内就往下走。 */
const settle = async (ms = 1400) => {
  await page.evaluate(async max => {
    const snapshot = () => document.body.innerHTML.length + '|' + (document.querySelector('#veil')?.classList.contains('open') ? '1' : '0') + '|' + (document.querySelector('.view.active')?.id ?? '');
    let last = snapshot(), still = 0;
    const started = performance.now();
    while (performance.now() - started < max) {
      await new Promise(resolve => setTimeout(resolve, 60));
      const now = snapshot();
      if (now === last) { still += 1; if (still >= 2) return; } else { still = 0; last = now; }
    }
  }, ms);
};

// ── 记账：每条判据 → 实测 → 判定 ──
const checks = [];
const record = (id, criterion, criterionText, verdict, measured, evidence = '') => { checks.push({id, criterion, criterionText, verdict, measured, evidence}); };
const PASS = '合规'; const FAIL = '违规'; const UNKNOWN = '无法机械判定';

/** 当前走到哪一段：evaluate 里出错时能定位到具体判据，不用猜行号。 */
const where = {at: '启动'};
const pageErrors = [];
page.on('pageerror', error => {
  const text = where.at + ' · ' + error.message;
  pageErrors.push(text);
  // **连调用栈一起记**。只记 message 时，"Cannot set properties of null" 根本看不出
  // 是谁在写 innerHTML —— 报了个红却没给任何可查的线索，等于没报。
  const frames = (error.stack || '').split('\n').slice(1, 4).map(line => line.trim());
  console.log('（页面错误 · ' + text.slice(0, 140) + '）');
  for (const frame of frames) console.log('   ↳ ' + frame.slice(0, 220));
});
const errorsSince = mark => pageErrors.filter(text => text.startsWith(mark));

/** 采集：点击时调用了哪些接口（用来分辨"直接生效"和"先弹确认"）。 */
await page.evaluateOnNewDocument(() => {
  window.__api = [];
  const original = window.fetch;
  window.fetch = async (...args) => {
    const entry = {at: Date.now(), action: null, key: null, status: null, ok: false};
    window.__api.push(entry);
    try {
      const body = args[1]?.body;
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        entry.action = parsed.action ?? null;
        entry.key = parsed.key ?? null;
      }
    } catch { /* 非 JSON 请求不记账 */ }
    const response = await original(...args);
    entry.status = response.status;
    entry.ok = response.ok;
    return response;
  };
});

const apiCalls = () => page.evaluate(() => window.__api.splice(0, window.__api.length));
/** 在页面里安全地点一下：普通按钮用 .click()，<details>/<summary> 这类非按钮元素派发真实鼠标事件。
 *  元素上不一定有 .click —— 统一走它，避免"某个控件不是按钮"就把整条门禁打断。 */
const safeClick = () => page.evaluateOnNewDocument(() => {
  /** 给人看的控件名：文字 > id > aria-label > 类名，避免出现一堆空名字。 */
  window.__describeControl = node => {
    if (!node) return '（找不到）';
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 22);
    if (text) return text;
    if (node.id) return '#' + node.id;
    const aria = node.getAttribute?.('aria-label');
    if (aria) return 'aria:' + aria;
    const data = Object.keys(node.dataset ?? {})[0];
    if (data) return 'data-' + data + '=' + String(node.dataset[data]).slice(0, 16);
    return node.tagName.toLowerCase() + '.' + (node.className || '').toString().split(/\s+/)[0];
  };
  window.__safeClick = node => {
    if (!node) return false;
    if (typeof node.click === 'function') { node.click(); return true; }
    // 真实鼠标的顺序是 pointerdown → pointerup → click。
    // 只派发 click 会让**只监听 pointer 事件**的控件看起来"点了没反应" ——
    // 画布上的连线（<g role=button>，SVG 元素没有 .click()）就是这种：
    // 它明明接了 edgeDialog，第一版却判它"死了"。那是门禁失真，不是界面缺陷。
    const box = node.getBoundingClientRect ? node.getBoundingClientRect() : {left: 0, top: 0, width: 1, height: 1};
    const options = {bubbles: true, cancelable: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0};
    try { node.dispatchEvent(new PointerEvent('pointerdown', options)); } catch {}
    try { node.dispatchEvent(new PointerEvent('pointerup', options)); } catch {}
    node.dispatchEvent(new MouseEvent('click', options));
    return true;
  };
});
await safeClick();
const listOf = kind => page.evaluate(async kind => {
  const response = await fetch('/personal-workstation/api', {method: 'POST', headers: {'content-type': 'application/json', 'x-workstation-client': '1'}, body: JSON.stringify({action: 'list', kind, workspace: 'w', limit: 200})});
  const data = await response.json();
  return (data.items ?? []).map(item => item.data.title);
}, kind);

const gotoView = async view => {
  await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
  await settle(1200);
};
const fresh = async view => {
  await page.goto(base, {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 20000});
  if (view) await gotoView(view);
  await apiCalls();
};

/** 当前屏幕状态：弹窗是否开着、哪个视图是激活的、撤销条什么样。 */
const surface = () => page.evaluate(() => {
  const bar = document.querySelector('#undobar');
  const rect = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
  return {
    veil: document.querySelector('#veil')?.classList.contains('open') ?? false,
    view: document.querySelector('.view.active')?.id ?? null,
    type: document.querySelector('#detailtype')?.textContent ?? null,
    title: document.querySelector('#detailtitle')?.textContent ?? null,
    bodyLength: (document.querySelector('#detailbody')?.innerHTML ?? '').length,
    bar: bar && !bar.hidden ? {text: bar.textContent.replace(/\s+/g, ' ').trim(), button: bar.querySelector('[data-undobutton]')?.textContent?.trim() ?? null, left: Math.round(rect.left), top: Math.round(rect.top), viewportBottom: Math.round(window.innerHeight - rect.bottom)} : null,
    toast: document.querySelector('#toast')?.textContent?.trim() ?? null,
  };
});
const shoot = async name => { await page.screenshot({path: shots + name + '.png'}); return 'prototype/screenshots/charter-ux/' + name + '.png'; };

/** 可点击判定：元素可见、未被禁用、且落在视口内。 */
const VISIBLE = `node => node.offsetParent !== null && !node.disabled && node.getClientRects().length > 0`;

try {
  // ══════════════════════════════════════════════════════════════════════
  // A · 宪章第五条 · 确认强度分级
  // ══════════════════════════════════════════════════════════════════════

  // A1 · 你自己主动的操作必须直接生效 + 左下「已保存 · 撤销」，不弹"同意"
  await fresh();
  await page.click('#create');
  await wait(700);
  await page.evaluate(() => document.querySelector('#detailbody [data-kind="task"]')?.click());
  await settle(1200);
  const createdTitle = '门禁·新建任务';
  await page.evaluate(title => { const input = document.querySelector('#detailbody [data-field="title"]'); if (input) input.value = title; }, createdTitle);
  await apiCalls();
  await page.evaluate(() => document.querySelector('#objpreview')?.click());
  await settle(1500);
  const afterCreate = await surface();
  const createCalls = await apiCalls();
  const shotA1 = await shoot('A1-新建任务-保存后');
  const tasksAfterCreate = await listOf('task');
  const directCommit = createCalls.some(call => call.action === 'commit' && call.ok);
  const askedAgree = createCalls.some(call => call.action === 'commit') && !directCommit;
  const veto = createCalls.some(call => call.action === 'cancel_draft');
  const barOk = Boolean(afterCreate.bar) && /已保存|已新建/.test(afterCreate.bar.text);
  const barAtBottomLeft = Boolean(afterCreate.bar) && afterCreate.bar.left <= 40 && afterCreate.bar.viewportBottom <= 60;
  const charteredText = Boolean(afterCreate.bar) && afterCreate.bar.text.includes('已保存 · 撤销');
  const persisted = tasksAfterCreate.includes(createdTitle);
  record('A1a', '宪章第五条', '你自己主动的操作 → 直接生效', (directCommit && persisted && !askedAgree && !veto) ? PASS : FAIL,
    `新建任务保存：接口调用 ${createCalls.map(call => call.action + (call.ok ? '✓' : '✗')).join(' → ')}；列表里已出现「${createdTitle}」=${persisted}；弹"同意"=${askedAgree}`,
    shotA1);
  record('A1b', '宪章第五条 / VI §7', '生效后左下出现「已保存 · 撤销」', (barOk && barAtBottomLeft) ? PASS : FAIL,
    `撤销条=${afterCreate.bar ? `文字「${afterCreate.bar.text}」· 按钮「${afterCreate.bar.button}」· 距左 ${afterCreate.bar.left}px · 距底 ${afterCreate.bar.viewportBottom}px` : '不存在'}`,
    shotA1);
  record('A1c', '宪章第五条 / registry.registry.undo', '撤销条文案与注册表一致（左下常驻「已保存 · 撤销」）', charteredText ? PASS : FAIL,
    `实测文案「${afterCreate.bar?.text ?? '（无）'}」；注册表要求逐字「已保存 · 撤销」；实测${charteredText ? '一致' : '是「已保存：<动作名>」+ 独立「撤销」按钮，且 9 秒后自动隐藏（见 A2b）'}`,
    shotA1);

  // A2 · 撤销是真的：点撤销后数据回到改动前
  const beforeUndo = await listOf('task');
  await page.evaluate(() => document.querySelector('#undobar [data-undobutton]')?.click());
  await wait(1600);
  const afterUndo = await listOf('task');
  const shotA2 = await shoot('A2-撤销后');
  const reverted = JSON.stringify(beforeUndo.filter(t => t !== createdTitle)) === JSON.stringify(afterUndo);
  record('A2a', '宪章第五条 / 03 §3 随时可退', '撤销必须是真的（数据回到改动前）', reverted ? PASS : FAIL,
    `撤销前 ${JSON.stringify(beforeUndo)}\n             撤销后 ${JSON.stringify(afterUndo)}`,
    shotA2);

  // A2b · 撤销条是否常驻（"常驻"是判据的一部分）
  await fresh();
  await page.click('#create');
  await wait(600);
  await page.evaluate(() => document.querySelector('#detailbody [data-kind="task"]')?.click());
  await settle(1100);
  await page.evaluate(() => { const input = document.querySelector('#detailbody [data-field="title"]'); if (input) input.value = '门禁·常驻测试'; });
  await page.evaluate(() => document.querySelector('#objpreview')?.click());
  await settle(1200);
  const barAt9s = await page.evaluate(() => new Promise(resolve => {
    const bar = document.querySelector('#undobar');
    const first = bar && !bar.hidden;
    setTimeout(() => resolve({first, later: Boolean(bar && !bar.hidden), text: bar?.textContent.replace(/\s+/g, ' ').trim() ?? null}), 9600);
  }));
  record('A2b', 'VI §14 V8 表 · 宪章第五条「常驻」', '撤销条常驻（不自行消失）', barAt9s.later ? PASS : FAIL,
    `保存后立即在=${barAt9s.first}；9.6 秒后仍在=${barAt9s.later}（实测 ${barAt9s.later ? '常驻' : '已被 9 秒定时器隐藏，文案「' + barAt9s.text + '」变空，用户回来时无法再撤销'}）`,
    await shoot('A2b-撤销条9秒后'));
  // 恢复现场：把这条测试任务撤掉
  await page.evaluate(() => document.querySelector('#undobar [data-undobutton]')?.click());
  await settle(1500);

  // A3 · 有风险动作（归档/删除）必须当场确认一次
  //  判据落点（03 §5 不打断清单："删除归档写日历对外发送（停住）"）：
  //    点「归档…」不能直接落库；要么当场弹确认，要么明确告诉用户"同意后才生效"并给出去处。
  const riskFlow = async (buttonId, label) => {
    await fresh('knowledge');
    await page.evaluate(() => { const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.textContent.includes('依据')); card?.click(); });
    await settle(1500);
    const openedEditor = await page.evaluate(() => {
      const node = [...document.querySelectorAll('#detailbody button')].find(item => item.textContent.trim() === '编辑判断');
      window.__safeClick(node);
      return Boolean(node);
    });
    await settle(1400);
    await apiCalls();
    const clicked = await page.evaluate(buttonId => {
      const node = document.querySelector(buttonId);
      window.__safeClick(node);
      return Boolean(node);
    }, buttonId);
    await wait(1500);
    const after = await surface();
    const calls = await apiCalls();
    const hasUndo = Boolean(after.bar);
    return {label, openedEditor, clicked, after, calls, hasUndo,
      drafted: calls.some(call => call.action === 'draft' && call.ok),
      committed: calls.some(call => call.action === 'commit'),
      askedConfirm: /同意|确认|不同意/.test(after.title ?? '') || /同意|确认/.test(after.toast ?? ''),
      stopped: /不能删除|会被拒绝|仍被/.test(after.toast ?? '')};
  };
  const archiveRisk = await riskFlow('#objarchive', '归档…');
  const archiveShot = await shoot('A3a-归档-确认');
  record('A3a', '宪章第五条 / 03 §5 不打断清单', '有风险动作（归档/删除）必须当场确认一次', (archiveRisk.drafted && !archiveRisk.committed && (archiveRisk.askedConfirm || archiveRisk.stopped)) ? PASS : FAIL,
    `「编辑判断」→ 点「归档…」→ 接口 ${archiveRisk.calls.map(call => call.action + (call.ok ? '✓' : '✗')).join(' → ') || '（没有调用）'}；已落库（commit）=${archiveRisk.committed}；弹窗标题「${archiveRisk.after.title}」；toast「${archiveRisk.after.toast ?? ''}」；撤销条=${archiveRisk.hasUndo ? '有「' + archiveRisk.after.bar.text + '」' : '无'}`,
    archiveShot);
  await page.evaluate(() => { const close = document.querySelector('#veil .close'); if (document.querySelector('#veil')?.classList.contains('open')) close?.click(); });
  await wait(400);

  const deleteRisk = await riskFlow('#objdelete', '删除…');
  const deleteShot = await shoot('A3a2-删除-确认');
  record('A3a2', '宪章第五条 / 03 §5 不打断清单', '有风险动作（删除）有明确拦阻或确认', (deleteRisk.drafted && !deleteRisk.committed) ? PASS : FAIL,
    `点「删除…」→ 接口 ${deleteRisk.calls.map(call => call.action + (call.ok ? '✓' : '✗')).join(' → ') || '（没有调用）'}；已落库（commit）=${deleteRisk.committed}；toast「${deleteRisk.after.toast ?? ''}」；撤销条=${deleteRisk.hasUndo ? '有' : '无'}`,
    deleteShot);
  await page.evaluate(() => { const close = document.querySelector('#veil .close'); if (document.querySelector('#veil')?.classList.contains('open')) close?.click(); });
  await wait(400);

  // A3b · 确认之后必须留撤销（03 §3 随时可退：即时生效旁永远有撤销）
  //  先把 A3a/A3a2 留下的草稿取消掉，回到"收件箱里只有一条待确认"的干净现场，
  //  再点「同意」；并且记录 toast 的**完整时间线**（成功提示和后到的报错都要看得见）。
  for (const leftover of store.inbox(ctx).filter(batch => batch.status === 'draft')) {
    store.cancelDraft(ctx, leftover.id, leftover.revision);
  }
  store.draft(ctx, {
    title: '同意路径取样改动',
    changes: [
      {op: 'create', id: 'a-approve-1', kind: 'artifact', data: {title: '同意路径资料', path: 'notes/approve.md', description: '取样'}},
      {op: 'update', id: 'p-c', expectedRevision: 1, data: {title: '技术适配', stage: '复盘'}},
    ],
  });
  await fresh('inbox');
  const approveTarget = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#inboxbody [data-batch]')].find(node => node.querySelector('[data-inboxapprove]'));
    return card ? {id: card.dataset.batch, title: card.querySelector('h2')?.textContent} : null;
  });
  await page.evaluate(() => {
    window.__toasts = [];
    const toast = document.querySelector('#toast');
    const read = () => {
      const text = toast.textContent.trim();
      const shown = !toast.classList.contains('show') ? false : true;
      const last = window.__toasts.at(-1);
      if (text && (!last || last.text !== text)) window.__toasts.push({at: Math.round(performance.now()), text, shown});
      else if (last && last.text === text && last.shown !== shown) last.shown = shown;
    };
    new MutationObserver(read).observe(toast, {subtree: true, childList: true, characterData: true, attributes: true});
  });
  await apiCalls();
  where.at = 'A3b 同意一条改动';
  const errorMark = pageErrors.length;
  await page.evaluate(() => { const card = [...document.querySelectorAll('#inboxbody [data-batch]')].find(node => node.querySelector('[data-inboxapprove]')); window.__safeClick(card?.querySelector('[data-inboxapprove]')); });
  await wait(2600);
  const afterApprove = await surface();
  const approveCalls = await apiCalls();
  const approveErrors = pageErrors.slice(errorMark);
  const toastLine = await page.evaluate(() => (window.__toasts ?? []).map(entry => `${entry.at}ms「${entry.text}」${entry.shown ? '（显示中）' : '（已收起）'}`));
  const approveShot = await shoot('A3b-同意一条改动之后');
  const approved = approveCalls.some(call => call.action === 'commit' && call.ok);
  const leftoverCards = await page.evaluate(() => [...document.querySelectorAll('#inboxbody [data-batch] h2')].map(node => node.textContent));
  record('A3b', '03 §4 已完成 / §3 随时可退', '确认过的动作旁边要有撤销（"左下常驻撤销"）', (approved && afterApprove.bar) ? PASS : FAIL,
    `点「同意」（${approveTarget?.title ?? '无卡片'}）→ 接口 ${approveCalls.map(call => call.action + (call.ok ? '✓' : '✗')).join(' → ')}；撤销条=${afterApprove.bar ? '「' + afterApprove.bar.text + '」' : '没有出现'}；点击后的提示时间线 ${toastLine.length ? toastLine.join(' → ') : '（没有任何提示）'}；收件箱剩余卡片 ${JSON.stringify(leftoverCards)}`,
    approveShot);
  record('A3c', '宪章第六条 诚实 / 第八条 无回执的假成功', '成功提示与真实结果一致（不能先报成功再报错）', (approveErrors.length || toastLine.some(text => /不存在|失败|错误/.test(text))) ? FAIL : PASS,
    (approveErrors.length || toastLine.some(text => /不存在|失败|错误/.test(text)))
      ? `点「同意」之后：接口 ${approveCalls.map(call => call.action + '=' + (call.ok ? 'ok' : '失败')).join(' → ')}；提示时间线 ${toastLine.join(' → ')}；页面异常 ${approveErrors.length} 条${approveErrors.length ? '：「' + approveErrors.map(text => text.slice(0, 80)).join('」「') + '」' : ''}`
      : `点「同意」之后提示时间线 ${toastLine.join(' → ')}；页面异常 0 条`,
    approveShot);

  // ══════════════════════════════════════════════════════════════════════
  // B · 交互律 06「向下钻，不横向跳」/ §3 零跳页
  // ══════════════════════════════════════════════════════════════════════

  ensurePendingChange('钻取取样用改动');
  const drillCases = [
    ['收件箱 · 待你决定的改动', 'inbox', '#inboxbody [data-batch]'],
    ['项目 · 项目卡片', 'projects', '#projectsbody [data-project]'],
    ['任务 · 任务卡片', 'tasks', '#tasksbody [data-task]'],
    ['知识 · 判断卡片', 'knowledge', '#knowbody [data-id]'],
    // 总览也是"列表→详情"的一处，而且用户 2026-10-16 正是在这里被跳走的 —— 取样不能漏掉它。
    // （原来漏掉，所以"点开数字跳页"这件事从这道判据底下走了过去。）
    ['总览 · 指标卡', 'home', '#home .metric'],
  ];
  const drillRows = [];
  for (const [label, view, selector] of drillCases) {
    await fresh(view);
    const before = await surface();
    const opened = await page.evaluate(selector => { const node = document.querySelector(selector); node?.click(); return Boolean(node); }, selector);
    await settle(1600);
    const after = await surface();
    const inPlace = opened && after.veil && before.view === after.view;
    drillRows.push({label, opened, inPlace, before: before.view, after: after.view, veil: after.veil});
    if (label.includes('项目')) await shoot('B4-项目详情-就地弹出');
    if (label.includes('任务')) await shoot('B4-任务详情-就地弹出');
  }
  const drillBad = drillRows.filter(row => !row.inPlace);
  record('B4', '交互律 06 / 03 §3 零跳页', '从任意列表点开一条记录 → 就地弹出详情（#veil.open），不换页', drillBad.length ? FAIL : PASS,
    drillRows.map(row => `${row.label}：点开=${row.opened} 弹窗开=${row.veil} 视图 ${row.before}→${row.after} ${row.inPlace ? '就地' : '跳页/未打开'}`).join('\n             '),
    'prototype/screenshots/charter-ux/B4-项目详情-就地弹出.png');

  // B4b · 总览上的**数字**点开必须就地弹窗（用户 2026-10-16 原话：「总览的一些数据点开就直接跳转了，
  // 我不需要跳转，按理应该是弹窗出现对应的列表」）。
  // 这一条单独写，是因为 D8 只判"有没有可点祖先"——**弹窗还是跳页它都不管**，用户报的 bug 从它底下走了过去。
  await fresh('home');
  const overviewNumberTargets = await page.evaluate(() => {
    const rows = [];
    for (const node of document.querySelectorAll('#home button, #home [role="button"]')) {
      const label = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/\d/.test(label)) continue;                       // 只看"带数字"的
      if (node.closest('.nav')) continue;                     // 侧栏导航不算
      if (node.offsetParent === null) continue;               // 看不见的不算
      rows.push({key: node.dataset.metric || node.dataset.countsPending || node.dataset.countsUnorganized || label.slice(0, 12), label: label.slice(0, 28)});
    }
    return rows;
  });
  const overviewNumberRows = [];
  for (const target of overviewNumberTargets) {
    await fresh('home');
    const before = await surface();
    const clicked = await page.evaluate(label => {
      const node = [...document.querySelectorAll('#home button, #home [role="button"]')]
        .find(n => (n.textContent || '').replace(/\s+/g, ' ').trim().startsWith(label));
      if (!node) return false;
      node.click();
      return true;
    }, target.label);
    await settle(1200);
    const after = await surface();
    overviewNumberRows.push({...target, clicked, inPlace: clicked && after.veil && before.view === after.view, before: before.view, after: after.view});
  }
  const jumped = overviewNumberRows.filter(row => !row.inPlace);
  record('B4b', '交互律 06 / §3 零跳页（用户 2026-10-16 点名）', '总览上带数字的可点元素 → 点开必须**就地弹出清单**，不换页', jumped.length ? FAIL : PASS,
    overviewNumberRows.map(row => `${row.label}：点开=${row.clicked} 视图 ${row.before}→${row.after} ${row.inPlace ? '就地弹窗' : '跳页/未打开'}`).join('\n             '),
    null);

  // B5 · 详情里的追问控件（依据/来源/历史/为什么这么建议/关联）必须在同一弹窗内原地展开
  const followUps = [];
  for (const [label, view, selector] of drillCases) {
    await fresh(view);
    await page.evaluate(selector => document.querySelector(selector)?.click(), selector);
    await settle(1600);
    // **口径以用户原话为准**：要原地展开的是「依据、来源、历史、为什么这么建议」四样。
    // 「在画布中查看关联」不在这四样里 —— 它字面就是"去看画布"，跳过去正是用户要的。
    //（原判据自作主张把"关联"也算了进来，于是把一次**显式导航**误判成"横向跳"。）
    const EXPLICIT_NAV = /在画布中|打开画布|全部关系|去画布/;
    const controls = await page.evaluate(() => [...document.querySelectorAll('#detailbody button, #detailbody summary, #detailbody [data-why]')]
      // 排除**禁用**控件：禁用的东西本来就不该有反应，把它算成"点了没反应"是判据口径错。
      .filter(node => node.offsetParent !== null && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .filter(node => !/在画布中|打开画布|全部关系|去画布/.test(node.textContent || ''))
      .map((node, index) => {
        const section = node.closest('[data-formsection], section, .modalactions');
        const heading = section?.querySelector('h3')?.textContent?.trim() ?? (section?.classList.contains('modalactions') ? '动作区' : '');
        const own = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 20) || (node.getAttribute('aria-label') ?? node.className.toString().slice(0, 18));
        node.setAttribute('data-b5', String(index));
        return {index, text: (heading ? heading + ' · ' : '') + own};
      }));
    for (const control of controls.slice(0, 3)) {
      const before = await surface();
      const clicked = await page.evaluate(index => {
        // 按**收集时打的标记**取元素。以前这里重新查了一遍、过滤条件还比收集时少两条
        // （收集排除了禁用控件与"显式跳画布"的动作，点击只排除了不可见），
        // 于是 index 错位：**报告里写的是 A，实际点的是 B** —— 证据和结论全对不上。
        const node = document.querySelector('#detailbody [data-b5="' + index + '"]');
        if (!node) return null;
        const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
        window.__safeClick(node);
        return text;
      }, control.index);
      if (clicked === null) continue;
      await wait(650);
      const after = await surface();
      // 允许的三种：仍开着且内容变化（原地展开）/ 弹窗内换了下一层（返回键仍在）/ 关掉弹窗＝有明确去处
      const stillOpen = after.veil && before.view === after.view;
      const contentChanged = after.bodyLength !== before.bodyLength || after.title !== before.title;
      const closed = !after.veil;
      followUps.push({where: label, control: clicked, stillOpen, contentChanged, closed, viewJumped: before.view !== after.view, type: after.type, title: after.title});
      if (closed) {
        // 关了弹窗就重新打开，继续测下一个控件
        await page.evaluate(selector => document.querySelector(selector)?.click(), selector);
        await settle(1400);
      }
    }
  }
  const jumps = followUps.filter(row => row.viewJumped);
  const silentFollowUps = followUps.filter(row => !row.stillOpen && !row.closed);
  const followShot = await shoot('B5-追问控件');
  record('B5', '交互律 06 / 03 §3 零跳页 / VI §9', '详情内点「依据/来源/历史/为什么这么建议/关联」→ 同一弹窗内原地展开', (jumps.length || silentFollowUps.length) ? FAIL : PASS,
    `共点 ${followUps.length} 个详情内追问控件；跳页 ${jumps.length} 个；点了既没原地展开也没关闭 ${silentFollowUps.length} 个\n             ` +
    (jumps.length || silentFollowUps.length
      ? [...jumps, ...silentFollowUps].map(row => `${row.where}「${row.control}」→ 弹窗仍开=${row.stillOpen} 内容变化=${row.contentChanged} 关闭=${row.closed} 跳视图=${row.viewJumped}`).join('\n             ')
      : `（${followUps.length} 个追问控件全部在同一弹窗内原地展开，没有跳页的）`),
    followShot);

  // B5b · 判断三要素是否缺项（VI V2：依据可点、就地展开、显示条数与出处）
  await fresh('knowledge');
  const openedFixture = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.textContent.includes('三要素夹具判断'));
    window.__safeClick(card);
    return Boolean(card);
  });
  await settle(1600);
  const judgmentDetail = await page.evaluate(() => {
    const text = document.querySelector('#detailbody')?.textContent ?? '';
    const evidence = document.querySelector('#detailbody [class="proof"]');
    return {
      text: text.replace(/\s+/g, ' ').trim().slice(0, 400),
      evidenceCount: /依据（(\d+) 条）/.exec(text)?.[1] ?? null,
      hasEvidenceHeading: text.includes('依据（'),
      hasSource: text.includes('会话原文') || text.includes('出处'),
      hasUncertainty: text.includes('不确定性'),
      hasValidFrom: text.includes('什么时候成立'),
      evidenceVisibleWithoutClick: Boolean(evidence),
      hasExpandControl: Boolean(document.querySelector('#detailbody details, #detailbody [data-why]')),
      evidenceClickable: [...document.querySelectorAll('#detailbody a[href], #detailbody button')].some(node => /依据|出处|查看来源/.test(node.textContent)),
      title: document.querySelector('#detailtitle')?.textContent ?? null,
    };
  });
  const judgmentShot = await shoot('B5b-判断详情三要素');
  record('B5b', 'VI §14 V2 判断三要素', '判断必须同时呈现依据（可点、就地展开、显示条数与出处）+ 不确定性 + 什么时候成立', (openedFixture && judgmentDetail.hasEvidenceHeading && judgmentDetail.hasUncertainty && judgmentDetail.hasValidFrom) ? PASS : FAIL,
    `打开的记录=「${judgmentDetail.title}」（点到卡片=${openedFixture}）；依据小节=${judgmentDetail.hasEvidenceHeading}（${judgmentDetail.evidenceCount} 条）· 出处文字=${judgmentDetail.hasSource} · 不确定性=${judgmentDetail.hasUncertainty} · 什么时候成立=${judgmentDetail.hasValidFrom} · 依据正文默认就地展开=${judgmentDetail.evidenceVisibleWithoutClick}`,
    judgmentShot);

  // B5c · 收件箱「为什么这么建议」是否原地展开（不跳页、内容真的生成）
  await fresh('inbox');   // 提议卡来自夹具里的 AI 提议批次
  const why = await page.evaluate(async () => {
    const node = document.querySelector('#inboxbody [data-why]');
    const card = node?.closest('[data-batch]');
    window.__whyCard = card?.querySelector('h2')?.textContent ?? null;
    if (!node) return {found: false};
    node.open = true;
    node.dispatchEvent(new Event('toggle'));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const chain = document.querySelector('#inboxbody [data-whychain]');
    return {found: true, open: node.open, text: chain?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160), view: document.querySelector('.view.active')?.id, veil: document.querySelector('#veil')?.classList.contains('open'), card: card?.querySelector('h2')?.textContent ?? null, evidence: card?.querySelector('[data-proposal]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null};
  });
  const whyShot = await shoot('B5c-为什么这么建议');
  record('B5c', '交互律 08 / F12', '「为什么这么建议」就地展开，列不出来就自曝是通用建议', (why.found && why.open && why.text) ? PASS : (why.found ? FAIL : UNKNOWN),
    why.found ? `卡片「${why.card}」；「为什么这么建议」展开=${why.open}；就地生成的内容「${why.text}」；依据与不确定性「${why.evidence}」；视图仍为 ${why.view}；没有跳页=${!why.veil}` : '夹具里没有渲染出 AI 提议卡，无法机械判定',
    whyShot);

  // ══════════════════════════════════════════════════════════════════════
  // C · 交互律 03「一个视图一个主动作」+ 品味「克制」
  // ══════════════════════════════════════════════════════════════════════
  const PAGES = [['总览', 'home'], ['收件箱', 'inbox'], ['关联空间', 'space'], ['项目', 'projects'], ['任务', 'tasks'], ['知识', 'knowledge'], ['日程与事务', 'personal']];
  const pageRows = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const row = await page.evaluate(label => {
      const active = document.querySelector('.view.active');
      const visible = node => node.offsetParent !== null && node.getClientRects().length > 0;
      const primaries = [...active.querySelectorAll('.btn.primary, button.primary')].filter(visible).map(node => (node.id ? '#' + node.id + ' ' : '') + node.textContent.replace(/\s+/g, ' ').trim().slice(0, 16));
      const controls = [...active.querySelectorAll('button,[role=button],a[href],select,input,textarea,[data-viselect]')].filter(visible);
      const names = controls.map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const tally = new Map();
      for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
      const duplicated = [...tally.entries()].filter(([name, count]) => count > 1 && name.length >= 2);
      return {label, view: active.id, primaries, controlCount: controls.length, duplicated};
    }, label);
    pageRows.push(row);
  }
  await fresh('projects');
  const projectShot = await shoot('C6-项目页-主色按钮');
  const multiPrimary = pageRows.filter(row => row.primaries.length > 1);
  record('C6', '交互律 03 / VI §14 V4 / 品味 克制', '每个一级页面主色按钮（.btn.primary）最多一个', multiPrimary.length ? FAIL : PASS,
    pageRows.map(row => `${row.label}：主色按钮 ${row.primaries.length} 个${row.primaries.length ? '（' + row.primaries.map(text => '「' + text + '」').join('、') + '）' : ''} · 可见控件 ${row.controlCount} 个`).join('\n             '),
    projectShot);

  const dupRows = pageRows.filter(row => row.duplicated.length);
  record('C7', '交互律 03 / 品味 克制 / 零重复', '同一屏里同一动作不出现两次（重复入口）', dupRows.length ? FAIL : PASS,
    dupRows.length ? dupRows.map(row => `${row.label}：` + row.duplicated.map(([name, count]) => `「${name}」×${count}`).join('、')).join('\n             ') : '七个一级页面内没有同名可见控件出现两次');

  // C7b · 顶栏常驻控件在全站每个页面都可见，等于"同一动作在每一屏都出现两次"
  await fresh();
  const topbar = await page.evaluate(() => [...document.querySelectorAll('.top .actions button, .top .actions a')].filter(node => node.offsetParent !== null).map(node => (node.id ? '#' + node.id + ' ' : '') + node.textContent.replace(/\s+/g, ' ').trim() + (node.className.includes('primary') ? '（主色）' : '')));
  const knowledgeEntry = await page.evaluate(() => {
    const result = {topbarFile: null, knowledgeTab: null};
    const bar = [...document.querySelectorAll('.top .actions button')].find(node => node.textContent.includes('文件与资料'));
    result.topbarFile = Boolean(bar);
    document.querySelector('.nav [data-view="knowledge"]')?.click();
    return result;
  });
  await settle(1400);
  const knowledgeTab = await page.evaluate(() => [...document.querySelectorAll('#knowtabs button')].map(node => node.textContent.trim() + '|' + (node.offsetParent !== null)));
  const knowledgeShot = await shoot('C7b-顶栏与知识页入口');
  record('C7b', '交互律 03 / 品味 克制 / 零重复', '顶栏常驻动作与页面内动作不重复（同一件事只做一个入口）', (topbar.some(text => text.includes('文件与资料'))) ? FAIL : PASS,
    `顶栏常驻：${topbar.join(' · ')}；知识页页签：${knowledgeTab.join(' · ')}；顶栏「文件与资料」与知识页「文件与资料」是同一处内容的两条路径`,
    knowledgeShot);

  // ══════════════════════════════════════════════════════════════════════
  // D · 交互律 04「任何状态都能点回到原因」+ 宪章第六条 诚实
  // ══════════════════════════════════════════════════════════════════════
  ensurePendingChange('数字取样用改动');
  const numberRows = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const rows = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const visible = node => node.offsetParent !== null && node.getClientRects().length > 0;
      const out = [];
      for (const node of active.querySelectorAll('b, strong, h2, small, p, span, time, .chip')) {
        if (!visible(node) || node.children.length) continue;
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (node.classList.contains('caldate') || node.classList.contains('axis')) continue;   // 日历数字与日期轴不是"状态"
        if (node.tagName === 'H2' || node.tagName === 'H3') continue;                          // 小标题不是"数字/状态"
        if (text.length > 60) continue;                                                        // 长句是说明文字，不是数字/状态
        // 带标签的说明句（"进度 = 已完成步骤 / 总步骤""有 1 条日程还没有同步…"）本身解释了数字，
        // 不算"点不动的数字"；这一项只找**光秃秃的计数**。
        if (/[：:＝=，,、。；;]/.test(text)) continue;
        // 只把**计数与状态**当判据对象：N 项/N 条/N 个/N 次、N/M、百分比、以及文字状态
        const isCount = /\d+\s*(项|条|个|次|步|件)/.test(text) || /\d+\s*\/\s*\d+/.test(text) || /\d+\s*%/.test(text) || /^\d+$/.test(text);
        const isStatus = /原因未记录|未记录|未接入|等待|阻塞|逾期|待核对|未归属|已完成|进行中|失败|未同步/.test(text);
        if (!isCount && !isStatus) continue;
        if (/^\d+ 条?\s*$/.test(text)) continue;                                              // 纯"1 条"这类紧跟正文的计数不单列
        // 什么算"点得回原因"（2026-10-14 口径补齐，不是放宽）：
        //  ① 它自己或祖先已经是可点元素 —— 点了就能到那组对象（例：看板列头、任务卡里的步骤数）；
        //  ② 它是**当前视图的读数**，不是业务状态（缩放比例、已显示多少个对象/关联）。
        //     这一类必须由界面显式声明 `data-readout`，而且只认画布 chrome 附近的那几个 ——
        //     不允许拿它去标业务数字，否则这个口子就成了"把不想改的东西标一下"的后门。
        const clickable = Boolean(node.closest('button,[role=button],a[href],summary,label,select,input'))
          || Boolean(node.closest('[data-readout]') && node.closest('#space'))
          //  ③ 它是**分组计数**，而这一组的内容就在同一个容器里（或该组明确为空）——
          //     数字下面紧跟着就是那些对象，点它没有额外去处（看板列头就是这种）。
          //     同样要求界面显式声明 `data-groupcount`，并且这里会**真的去容器里找对象行**，
          //     声明了却没有内容也不算通过（否则又变成一个标记就能糊过去的口子）。
          || (() => {
               const group = node.closest('[data-groupcount]');
               if (!group) return false;
               const objects = '[data-task],[data-id],[data-project]';
               // 组内就有对象行，或者**这一屏**渲染了它所汇总的对象（指标行 + 看板就是这种：
               // 计数在上、明细在下，同屏可见，点它没有额外去处）。
               return Boolean(group.querySelector(objects) || group.querySelector('.v7-empty') || node.closest('.view.active')?.querySelector(objects));
             })();
        const inDialog = Boolean(node.closest('#veil'));
        out.push({text: text.slice(0, 32), clickable, inDialog, tag: node.tagName.toLowerCase(), cls: (node.className || '').toString().slice(0, 24)});
      }
      return out;
    });
    numberRows.push({label, view, rows});
  }
  const deadNumbers = [];
  for (const page of numberRows) {
    // 同一文本在页内多处出现只报一次；可点的、在弹窗里（弹窗本身是点进来的）不算死数字
    const seen = new Set();
    for (const row of page.rows) {
      if (row.clickable || row.inDialog) continue;
      if (seen.has(row.text)) continue;
      seen.add(row.text);
      deadNumbers.push({page: page.label, ...row});
    }
  }
  // D8 口径收紧（2026-10-16）：原来只判"这个数字有没有可点的祖先" —— **点开是弹窗还是跳页，它不管**。
  // 用户 2026-10-16 报的"总览数字点开就跳走了"正是从这道判据底下过去的（B4b 现在专门管总览，这里管全站）。
  // 做法：每页真的点第一个可点数字，断言**没有换页**（交互律 06：向下钻，不横向跳）。
  const d8Jumps = [];
  for (const pageRow of numberRows) {   // 注意：变量别叫 page —— 那会遮蔽 puppeteer 的 page
    const target = pageRow.rows.find(row => row.clickable && !row.inDialog);
    if (!target) continue;
    await fresh(pageRow.view);
    const before = await surface();
    const clicked = await page.evaluate(text => {
      const node = [...document.querySelectorAll('body *')].find(el => !el.children.length && (el.textContent || '').trim() === text);
      const hit = node?.closest('button,[role=button],a[href],[data-readout]');
      if (!hit) return null;
      // 这一处所在的位置决定了"点开该去哪"：
      //  · 在**导航项**里（例如「待你决定 2」的徽标贴在导航上）→ 它本来就是个入口，
      //    合理的行为是去**它自己那一项**，而不是留在原地；
      //  · 其余（读数、状态）→ 必须**原地**展开，不许横向跳（交互律 06）。
      const nav = hit.closest('[data-view]');
      const expected = nav ? (nav.dataset.view ?? null) : (hit.dataset.goto ?? null);
      hit.click();
      return {expected};
    }, target.text);
    await settle(1200);
    const after = await surface();
    if (clicked) {
      const expected = clicked.expected;
      if (expected) {
        // 导航类：必须去到它自己指的那一处（去了别处 = 徽标把人带错地方）
        if (after.view !== expected) d8Jumps.push(`${pageRow.label}「${target.text}」：导航标称去 ${expected}，实际去了 ${after.view}`);
      } else if (before.view !== after.view) {
        d8Jumps.push(`${pageRow.label}「${target.text}」：读数点开换页了（${before.view} → ${after.view}），应该原地展开`);
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await settle(400);
  }
  const numberShot = await shoot('D8-数字与状态');
  record('D8', '交互律 04 / 宪章第六条 诚实', '界面上每个数字/状态都能点开看到依据或说明；点不动的要列出来；点开不许换页', (deadNumbers.length || d8Jumps.length) ? FAIL : PASS,
    d8Jumps.length
      ? `数字/导航徽标的去处不对 ${d8Jumps.length} 处（读数要原地展开；导航徽标要去它自己那一项）：\n             ` + d8Jumps.join('\n             ')
      : deadNumbers.length ? `点不动的数字/状态 ${deadNumbers.length} 处（去重后）：\n             ` + deadNumbers.slice(0, 24).map(row => `${row.page} · ${row.tag}.${row.cls}「${row.text}」`).join('\n             ') + (deadNumbers.length > 24 ? `\n             …还有 ${deadNumbers.length - 24} 处` : '') : '没有找到"既不可点、又没有文字原因"的数字',
    numberShot);

  // D8b · 等待状态必须写明等谁/等什么（03 §4 等待：没写原因就"原因未记录"）
  await fresh('tasks');
  const waiting = await page.evaluate(() => {
    const text = document.querySelector('.view.active')?.textContent.replace(/\s+/g, ' ') ?? '';
    return {saysReasonNotRecorded: text.includes('原因未记录'), snippets: [...(document.querySelector('.view.active')?.querySelectorAll('p') ?? [])].map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.includes('等待')).slice(0, 6)};
  });
  const waitingShot = await shoot('D8b-等待状态');
  record('D8b', '03 §4 等待', '等待状态写明等谁/等什么；没写原因就显示「原因未记录」', waiting.saysReasonNotRecorded ? PASS : UNKNOWN,
    `任务页出现「原因未记录」=${waiting.saysReasonNotRecorded}；等待片段：${JSON.stringify(waiting.snippets)}`,
    waitingShot);

  // D9 · 未接入必须是灰字说明 + 没有假按钮
  await fresh();
  const unconnected = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.view.active [role=tab], .view.active .seg button')].map(node => node.textContent.trim()));
    const scan = async tab => {
      const rows = await page.evaluate(() => {
        const active = document.querySelector('.view.active');
        const visible = node => node.offsetParent !== null && node.getClientRects().length > 0;
        return [...active.querySelectorAll('p, small, .notice, .formhint, .chip')].filter(visible)
          .map(node => ({text: node.textContent.replace(/\s+/g, ' ').trim(), buttons: node.querySelectorAll('button').length}))
          .filter(row => /未接入|还没接|没接通|未加载|尚未|没有接入|未同步|不支|不可用|未接通/.test(row.text) && row.text.length < 260);
      });
      for (const row of rows) unconnected.push({page: label, tab: tab ?? '默认', ...row});
    };
    await scan(null);
    for (const tab of tabs) {
      await page.evaluate(text => { const node = [...document.querySelectorAll('.view.active [role=tab], .view.active .seg button')].find(item => item.textContent.trim() === text); node?.click(); }, tab);
      await wait(500);
      await scan(tab);
    }
  }
  const fakeButtons = [];
  for (const row of unconnected) {
    if (row.buttons === 0) continue;
    // 说明文字里带按钮：要看这个按钮是不是"做不到却给了按钮"
    fakeButtons.push(row);
  }
  const unconnectedShot = await shoot('D9-未接入');
  record('D9', '03 §4 未接入 / VI §7 / 宪章第八条', '未接入的能力是灰字说明 + 没有假按钮', fakeButtons.length ? FAIL : PASS,
    `全站"未接入/未同步/未加载"类说明 ${unconnected.length} 条；其中说明块里还嵌着按钮的 ${fakeButtons.length} 条` +
    (unconnected.length ? `\n             样例：` + unconnected.slice(0, 8).map(row => `${row.page}/${row.tab}「${row.text.slice(0, 80)}」按钮 ${row.buttons} 个`).join('\n             ') : ''),
    unconnectedShot);

  // D9b · 点"未接入"的能力会不会点出一个假结果（按钮点了只弹一句"没接上"＝假按钮）
  await fresh('space');   // 「AI 如何发现关系」只存在于关联空间
  await apiCalls();
  const aiExplain = await page.evaluate(async () => {
    const node = document.querySelector('#aiExplain');
    if (!node) return {found: false};
    window.__safeClick(node);
    await new Promise(resolve => setTimeout(resolve, 900));
    return {found: true, veil: document.querySelector('#veil')?.classList.contains('open'), view: document.querySelector('.view.active')?.id, body: document.querySelector('#detailbody')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200)};
  });
  const aiShot = await shoot('D9b-AI如何发现关系');
  record('D9b', '03 §4 未接入 / 宪章第六条 诚实', '未接入的能力点了不给假结果、也不伪装成已实现', aiExplain.found ? ((aiExplain.veil || aiExplain.body) ? PASS : FAIL) : UNKNOWN,
    aiExplain.found ? `点「AI 如何发现关系」→ 弹窗开=${aiExplain.veil} 视图=${aiExplain.view}；内容「${aiExplain.body}」` : '页面上没有这个控件',
    aiShot);

  // ══════════════════════════════════════════════════════════════════════
  // E · 宪章第七条 可读 + VI §2 颜色不单独承担判断
  // ══════════════════════════════════════════════════════════════════════
  const colorOnly = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const rows = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const visible = node => node.offsetParent !== null && node.getClientRects().length > 0;
      const out = [];
      // 只看真正的状态表达：状态点 / 状态芯片 / 状态图标（VI §2、§13 门禁 11）
      for (const node of active.querySelectorAll('.dot, .statusdot, .fdot, [data-state], .chip')) {
        if (!visible(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) continue;
        const style = getComputedStyle(node);
        const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.borderTopStyle !== 'none';
        if (!painted) continue;
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        const row = node.closest('button,[role=button],li,p,section,div') ?? node.parentElement;
        const around = (row?.textContent ?? '').replace(/\s+/g, ' ').trim();
        out.push({
          tag: node.tagName.toLowerCase(),
          cls: (node.className || '').toString().slice(0, 26),
          text: text.slice(0, 24),
          around: around.slice(0, 90),
          size: Math.round(rect.width) + '×' + Math.round(rect.height),
          label: node.getAttribute('aria-label'),
          dataState: node.getAttribute('data-state') ?? node.dataset?.fdot ?? null,
        });
      }
      return out;
    });
    for (const row of rows) colorOnly.push({page: label, ...row});
  }
  // 合规条件（VI §2 / 门禁 11）：色点自己或它所在的行/卡片必须有文字。
  const colorOnlyBad = colorOnly.filter(row => !row.text && !row.around && !row.label);
  const colorOnlyShot = await shoot('E10-状态色点');
  record('E10', 'VI §2 / VI §13 门禁 11 / 宪章第七条 可读', '状态不靠颜色单独表达：绿点/赭色/虚线旁必须有文字', colorOnlyBad.length ? FAIL : PASS,
    `全站状态点/状态芯片 ${colorOnly.length} 个；其中自己没字、所在行也没字、也没有 aria-label 的 ${colorOnlyBad.length} 个` +
    (colorOnly.length ? `\n             样例：` + colorOnly.slice(0, 5).map(row => `${row.page} · ${row.tag}.${row.cls}（${row.size}${row.dataState ? ' data-state=' + row.dataState : ''}）所在行「${row.around.slice(0, 60)}」`).join('\n             ') : ''),
    colorOnlyShot);

  // E10b · 颜色语义（VI §2）：knowledge 紫只能表达知识/记忆/AI 推理，不能当"项目色/进度色"
  const purpleMisuse = [];
  for (const [label, view] of PAGES) {
    await fresh(view);   // 与 E10 各自独立取样：两次扫描元素不同，合并会让口径变模糊
    const rows = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const visible = node => node.offsetParent !== null && node.getClientRects().length > 0;
      const out = [];
      for (const node of active.querySelectorAll('*')) {
        if (!visible(node) || node.children.length) continue;
        const style = getComputedStyle(node);
        const painted = /243,\s*239,\s*248|117,\s*85,\s*161/.test(style.backgroundColor) || /243,\s*239,\s*248|117,\s*85,\s*161/.test(style.color);
        if (!painted) continue;
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        const row = node.closest('button,[role=button],li,p,section,div') ?? node.parentElement;
        const context = ((row?.className || '').toString() + ' ' + (node.className || '').toString()).toLowerCase();
        // 例外：产物/判断卡有 ——pb（逐项目数据色），但数据色表里没有这个紫；knowledge 系容器不算
        if (/knowledge|memory|judgment|topic|ai-|proposal|proof|memo|brief|resource|inboxproposal|chip stage-since/.test(context)) continue;
        out.push({
          tag: node.tagName.toLowerCase(),
          cls: (node.className || '').toString().slice(0, 28),
          text: text.slice(0, 26),
          size: Math.round(node.getBoundingClientRect().width) + '×' + Math.round(node.getBoundingClientRect().height),
          parent: (row?.className || '').toString().slice(0, 40),
          ownInline: (node.getAttribute('style') || '').slice(0, 70),
          parentInline: (node.parentElement?.getAttribute('style') || '').slice(0, 70),
          paint: /243,\s*239,\s*248/.test(style.backgroundColor) ? 'bg=knowledge-soft' : (/243,\s*239,\s*248/.test(style.color) ? 'color=knowledge-soft' : (/117,\s*85,\s*161/.test(style.backgroundColor) ? 'bg=knowledge' : 'color=knowledge')),
        });
      }
      return out;
    });
    for (const row of rows) purpleMisuse.push({page: label, ...row});
  }
  const purpleShot = await shoot('E10b-紫被当项目色');
  record('E10b', 'VI §2 色彩使用规则 / §14 V5', 'knowledge 紫只表达知识/记忆/AI 推理；不得当项目色或进度色', purpleMisuse.length ? FAIL : PASS,
    purpleMisuse.length
      ? `knowledge 紫（#7555A1 / #F3EFF8）出现在与知识无关的元素上 ${purpleMisuse.length} 处：\n             ` + purpleMisuse.slice(0, 10).map(row => `${row.page} · ${row.tag}.${row.cls}（${row.size}，${row.paint}）「${row.text}」父=${row.parent}｜自身 style=${row.ownInline || '无'}｜父 style=${row.parentInline || '无'}`).join('\n             ')
      : '没有发现 knowledge 紫被用在知识/记忆/判断以外的元素上',
    purpleShot);

  // E11 · 点了没有任何反应的可见控件（interaction-audit 已查，这里抽查复核：只测稳定、无副作用的那几类）
  const deadControls = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const total = await page.evaluate(() => [...document.querySelectorAll('.view.active button, .view.active [role=button], .view.active a[href]')].filter(node => node.offsetParent !== null).length);
    const sample = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.view.active button, .view.active [role=button], .view.active a[href]')].filter(node => node.offsetParent !== null);
      // 只抽"看起来是本地交互"的：页签 / 筛选 / 放大缩小 / 复位 / 分段选择，且跳过破坏性动作
      const safe = nodes.filter(node => !/删除|归档|清空|退出|登录|同意|不同意|新建|录入/.test(node.textContent));
      return safe.slice(0, 8).map(node => window.__describeControl(node) + ' ⟨' + node.tagName.toLowerCase() + (node.dataset && Object.keys(node.dataset).length ? ' data-' + Object.keys(node.dataset)[0] + '=' + String(Object.values(node.dataset)[0]).slice(0, 18) : '') + '⟩');
    });
    for (let index = 0; index < sample.length; index += 1) {
      const result = await page.evaluate(async index => {
        const nodes = [...document.querySelectorAll('.view.active button, .view.active [role=button], .view.active a[href]')].filter(node => node.offsetParent !== null && !/删除|归档|清空|退出|登录|同意|不同意|新建|录入/.test(node.textContent));
        const node = nodes[index];
        if (!node) return null;
        const label = window.__describeControl(node) + ' ⟨' + node.tagName.toLowerCase() + (node.dataset && Object.keys(node.dataset).length ? ' data-' + Object.keys(node.dataset)[0] + '=' + String(Object.values(node.dataset)[0]).slice(0, 18) : '') + '⟩';
        if (node.classList.contains('active') || node.getAttribute('aria-current') === 'page') return {label, skipped: '已选中态'};
        const read = () => ({
          html: document.querySelector('.view.active')?.innerHTML.length ?? 0,
          text: (document.querySelector('.view.active')?.textContent ?? '').replace(/\s+/g, ' ').trim().length,
          veil: document.querySelector('#veil')?.classList.contains('open') ?? false,
          toast: document.querySelector('#toast')?.textContent ?? '',
          view: document.querySelector('.view.active')?.id ?? null,
        });
        const before = read();
        window.__safeClick(node);
        await new Promise(resolve => setTimeout(resolve, 700));
        const after = read();
        // 画布会持续重绘，所以不数"任意 DOM 变更"，只认：文字/结构长度变了、弹窗开了、提示变了、视图换了。
        const changed = before.html !== after.html || before.text !== after.text || before.veil !== after.veil || before.toast !== after.toast || before.view !== after.view;
        return {label, changed, before, after};
      }, index);
      if (!result || result.skipped) continue;
      if (!result.changed) deadControls.push({page: label, control: result.label});
      await page.evaluate(() => { const close = document.querySelector('#veil .close'); if (document.querySelector('#veil')?.classList.contains('open')) close?.click(); });
      await wait(250);
    }
  }
  const deadControlShot = await shoot('E11-点了没反应');
  // 口径要诚实：这只是**抽查**。`interaction-audit.mjs` 是更全的手工工具，但它**不在 verify 链里**
  // （单次跑超过 10 分钟），原来这里写"与它交叉复核"是把一件没发生的事说成发生了。
  record('E11', '宪章第六条 有重量「点了没反应」', '抽查的可见控件点击后都有 DOM 变化（全量体检另有手工工具，不在 verify 链里）', deadControls.length ? FAIL : PASS,
    deadControls.length ? `抽查发现 ${deadControls.length} 个点了无变化的控件：` + deadControls.map(row => `${row.page}「${row.control}」`).join('、') : '抽查的可见控件点击后都有 DOM 变化（全量体检请手工跑 interaction-audit.mjs，它不在 verify 链里）',
    deadControlShot);

  // ══════════════════════════════════════════════════════════════════════
  // F · 交互律 01/05 + 点击步数
  // ══════════════════════════════════════════════════════════════════════
  // F12 · 低风险动作不许事先弹确认（用户硬要求 2026-10-13：弹了确认的必须同时有撤销）
  //  口径：只看真正的**确认/中断层**（弹窗里带 同意/不同意/确认 这类按钮），
  //  打开详情、打开编辑器都不算"确认"——那是导航，不是拦阻。
  const surpriseDialogs = [];
  for (const [label, view] of PAGES) {
    await fresh(view);
    const names = await page.evaluate(() => [...document.querySelectorAll('.view.active button, .view.active [role=button]')]
      .filter(node => node.offsetParent !== null)
      .filter(node => !/删除|归档|清空|同意|不同意|退出|登录/.test(node.textContent))
      .map(node => window.__describeControl(node)));
    for (let index = 0; index < Math.min(names.length, 6); index += 1) {
      await apiCalls();
      const result = await page.evaluate(async index => {
        const nodes = [...document.querySelectorAll('.view.active button, .view.active [role=button]')]
          .filter(node => node.offsetParent !== null)
          .filter(node => !/删除|归档|清空|同意|不同意|退出|登录/.test(node.textContent));
        const node = nodes[index];
        if (!node) return null;
        const label = window.__describeControl(node);
        const wasOpen = document.querySelector('#veil')?.classList.contains('open') ?? false;
        window.__safeClick(node);
        await new Promise(resolve => setTimeout(resolve, 800));
        const isOpen = document.querySelector('#veil')?.classList.contains('open') ?? false;
        const dialog = document.querySelector('#veil [role="dialog"]');
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])].map(item => item.textContent.replace(/\s+/g, ' ').trim());
        const isConfirm = buttons.some(text => /^(同意|确认|确定|全部同意|继续)/.test(text)) || buttons.some(text => /不同意|取消本次/.test(text));
        return {label, openedDialog: !wasOpen && isOpen, title: document.querySelector('#detailtitle')?.textContent ?? null, buttons: buttons.slice(0, 6), isConfirm};
      }, index);
      if (!result) continue;
      if (result.openedDialog && result.isConfirm) {
        const calls = await apiCalls();
        surpriseDialogs.push({page: label, control: result.label, dialog: result.title, buttons: result.buttons, calls: calls.map(call => call.action)});
      }
      await page.evaluate(() => { const close = document.querySelector('#veil .close'); if (document.querySelector('#veil')?.classList.contains('open')) close?.click(); });
      if (result.openedDialog && result.isConfirm === false) await wait(500);
      await wait(220);
    }
  }
  const surpriseShot = await shoot('F12-弹确认框');
  record('F12', '交互律 01/05 / 03 §5 不打断清单 / 用户硬要求 2026-10-13', '低风险动作不许事先弹确认；弹了确认的必须同时有撤销', surpriseDialogs.length ? FAIL : PASS,
    surpriseDialogs.length
      ? surpriseDialogs.map(row => `${row.page}「${row.control}」→ 弹出确认层「${row.dialog}」，按钮 ${row.buttons.map(text => '「' + text + '」').join('')}，接口 ${row.calls.join(' → ')}`).join('\n             ')
      : `七个一级页面各抽 6 个可见控件点击，没有一个是"先弹确认再做事"（打开详情/编辑器不算确认层）；破坏性动作不在本项抽查里（那类必须确认，见 A3a）`,
    surpriseShot);

  // F13 · 五个常见任务的点击步数。**真实点击测量**，不是人工记录。
  //
  // 这一项以前是"叙述冒充测量"：代码确实点了，但记下来的步数是写死的字符串数组，
  // 于是路径改了它还在念旧台词（②的阶段、③的核对就是这么过期的）。
  // 现在每一步都必须**真的在 DOM 里点到**：找不到就记 broken，这一条按"路径已变"报出来，
  // 而不是继续给出一个已经不对的步数。
  const steps = [];
  const walk = async (name, run) => {
    await fresh();
    const taps = [];
    const tap = async (label, action) => {
      let ok = false;
      try { ok = await action() !== false; } catch { ok = false; }
      if (ok) taps.push(label);
      return ok;
    };
    let broken = null;
    const mark = label => { broken = label; };
    const detail = (await run({tap, mark})) ?? {};
    steps.push({name, clicks: taps, broken, note: detail.note});
  };
  /** 在页面里点到某个元素（真的用它自己的 click 路径），返回有没有点到。 */
  const tapIn = async (selector, label, {tap}) => tap(label, async () => {
    const found = await page.evaluate(s => {
      const node = document.querySelector(s);
      if (!node || !node.offsetParent && node.tagName !== 'g') return false;
      node.click();
      return true;
    }, selector);
    if (found) await wait(600);
    return found;
  });

  // ① 新建一个任务：顶栏「新建」→「任务」→ 填名称（打字不计点击）→「保存」
  await walk('① 新建一个任务', async helpers => {
    if (!await helpers.tap('顶栏「新建」', async () => { await page.click('#create'); await wait(700); return true; })) helpers.mark('顶栏「新建」');
    await tapIn('#detailbody [data-kind="task"]', '菜单「任务」', helpers);
    await settle(1100);
    await page.evaluate(() => { const input = document.querySelector('#detailbody [data-field="title"]'); if (input) input.value = '步数测试任务'; });
    await tapIn('#objpreview', '「保存」（填名称是打字，不计点击）', helpers);
    await settle(1600);
    await page.evaluate(() => document.querySelector('#veil .close')?.click());
    return {note: null};
  });

  // ② 改一个项目的阶段：项目卡片 → 点阶段格（2026-10-14 起阶段条每格可点，不再需要开编辑弹窗）
  await walk('② 改一个项目的阶段', async helpers => {
    await gotoView('projects');
    await tapIn('#projectsbody [data-project]', '项目页「项目卡片」', helpers);
    await settle(1400);
    // 阶段格：点"复盘"那一格。以前这条路要开「编辑项目」→下拉→选→保存（5 步），现在是一格。
    await tapIn('[data-phase-set="复盘"]', '点阶段格「复盘」', helpers);
    await settle(1200);
    await page.evaluate(() => document.querySelector('#veil .close')?.click());
    await wait(300);
    return {note: null};
  });

  // ③ 把一条记忆引用标记为已核对来源：知识页 → 长期记忆 → 卡片 → 详情里的核对按钮
  await walk('③ 把一条资料标记为已核对', async helpers => {
    await gotoView('knowledge');
    await tapIn('#knowtabs [data-know="memory"]', '知识页页签「长期记忆」', helpers);
    await settle(900);
    await tapIn('#knowbody [data-id]', '引用卡片', helpers);
    await settle(1100);
    // 2026-10-14 起：自己点的核对**直接生效 + 可撤销**，不再生成待确认的改动（不再需要第 4 步）。
    await tapIn('#detailbody [data-verify="verified"]', '详情「标记为已核对来源」', helpers);
    await settle(1200);
    const appliedDirectly = await page.evaluate(() => {
      const bar = document.querySelector('#undobar');
      return Boolean(bar && !bar.hidden);
    });
    await page.evaluate(() => document.querySelector('#veil .close')?.click());
    await wait(300);
    return {note: appliedDirectly ? null : '点了核对之后没有出现撤销条 —— 可能又变成了"再要你确认一次"（契约②要求自己的操作直接生效）'};
  });

  // ④ 把一个待确认的改动同意掉
  await walk('④ 把一个待确认的改动同意掉', async helpers => {
    await gotoView('inbox');
    await settle(700);
    await tapIn('[data-inboxapprove]', '导航「收件箱」→ 卡片「同意」', helpers);
    await settle(1200);
    return {note: null};
  });

  // ⑤ 找一个项目下的材料并打开：项目卡片 → 材料行「打开」
  await walk('⑤ 找一个项目下的材料并打开', async helpers => {
    await gotoView('projects');
    const total = await page.evaluate(() => document.querySelectorAll('#projectsbody [data-project]').length);
    let opened = false;
    for (let index = 0; index < total; index += 1) {
      await page.evaluate(i => document.querySelectorAll('#projectsbody [data-project]')[i]?.click(), index);
      await settle(1400);
      const hasMaterial = await page.evaluate(() => Boolean(document.querySelector('[data-material-open]')));
      if (hasMaterial) { opened = true; break; }
      await page.evaluate(() => document.querySelector('#veil .close')?.click());
      await wait(300);
    }
    if (!opened) {
      helpers.mark('详情材料行「打开」');
      return {note: '夹具里没有任何项目带材料行，这条量不出来（不是界面缺陷，但也不能算通过）'};
    }
    // 打开卡片本身算一次点击（循环里已经点过了，这里只记录，不再点第二次）。
    helpers.tap('项目页「项目卡片」', async () => true);
    await tapIn('[data-material-open]', '详情材料行「打开」', helpers);
    await tapIn('[data-material-open]', '详情材料行「打开」', helpers);
    await settle(900);
    return {note: null};
  });

  // 路径断掉的条目单独列出来：那是"这条量不了"，不是"这条通过了"。
  const brokenSteps = steps.filter(row => row.broken);
  const overThree = steps.filter(row => !row.broken && (row.clicks ?? []).length > 3);
  record('F13', '交互律 01/05 + 用户硬要求（2026-10-13）', '常见任务从当前页面开始 ≤3 次点击；超过 3 步要指出多余在哪一步', overThree.length || brokenSteps.length ? FAIL : PASS,
    steps.map(row => `${row.name}：${row.broken ? '路径已变（卡在' + row.broken + '），这次量不了' : (row.clicks ?? []).length + ' 次点击 → ' + (row.clicks ?? []).join(' → ')}${row.note ? '\n             ↳ ' + row.note : ''}`).join('\n             '),
    await shoot('F13-常见任务步数'));

  // ══════════════════════════════════════════════════════════════════════
  // G · 03 §3 零等待感：点击后 1 秒内必须有可见反馈
  // ══════════════════════════════════════════════════════════════════════
  const latencyRows = [];
  const measureLatency = async (pageLabel, selectorOrText) => {
    const result = await page.evaluate(async target => {
      const isSelector = target.startsWith('#') || target.startsWith('.');
      const node = isSelector
        ? document.querySelector(target)
        : [...document.querySelectorAll('button,[role=button]')].find(item => item.textContent.replace(/\s+/g, ' ').trim() === target);
      if (!node || node.offsetParent === null) return null;
      const label = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 18);
      return await new Promise(resolve => {
        const started = performance.now();
        let settled = -1;
        let pending = false;
        const observer = new MutationObserver(() => {
          if (settled < 0 && !pending) {
            pending = true;
            requestAnimationFrame(() => requestAnimationFrame(() => {
              pending = false;
              if (settled < 0) settled = performance.now() - started;
            }));
          }
        });
        observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, characterData: true});
        node.click();   // 这里的目标一定是 button（选择器已限定），不需要安全点击
        setTimeout(() => {
          observer.disconnect();
          const elapsed = settled >= 0 ? Math.round(settled) : Math.round(performance.now() - started);
          resolve({label, ms: elapsed, timedOut: settled < 0});
        }, 1500);
      });
    }, selectorOrText);
    if (result) latencyRows.push({page: pageLabel, ...result});
  };

  for (const [label, view] of PAGES) {
    await fresh(view);
    await measureLatency(label, '.view.active .seg button:not(.active)');
    await measureLatency(label, '#create');
    await page.evaluate(() => { const close = document.querySelector('#veil .close'); if (document.querySelector('#veil')?.classList.contains('open')) close?.click(); });
    await wait(150);
    await measureLatency(label, '.nav [data-view="' + (view === 'home' ? 'inbox' : 'home') + '"]');
    await wait(250);
  }
  const slow = latencyRows.filter(row => row.ms > 1000);
  const latencyShot = await shoot('G14-点击反馈');
  record('G14', '03 §3 零等待感 / §4 进行中', '点击后 1 秒内出现可见反馈（弹窗/骨架/提示/DOM 变化）', slow.length ? FAIL : PASS,
    `采样 ${latencyRows.length} 次点击；首帧可见反馈中位 ${latencyRows.length ? latencyRows.map(row => row.ms).sort((a, b) => a - b)[Math.floor(latencyRows.length / 2)] : 0}ms；超 1000ms 的 ${slow.length} 次` +
    (slow.length ? '\n             ' + slow.map(row => `${row.page}「${row.label}」${row.ms}ms`).join('\n             ') : '') +
    `\n             最慢 5 次：` + latencyRows.slice().sort((a, b) => b.ms - a.ms).slice(0, 5).map(row => `${row.page}「${row.label}」${row.ms}ms${row.timedOut ? '(1.5s 内无变化)' : ''}`).join('、'),
    latencyShot);

  // ══════════════════════════════════════════════════════════════════════
  // 报告
  // ══════════════════════════════════════════════════════════════════════
  const order = ['A1a', 'A1b', 'A1c', 'A2a', 'A2b', 'A3a', 'A3a2', 'A3b', 'A3c', 'B4', 'B5', 'B5b', 'B5c', 'C6', 'C7', 'C7b', 'D8', 'D8b', 'D9', 'D9b', 'E10', 'E10b', 'E11', 'F12', 'F13', 'G14'];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const failed = sorted.filter(row => row.verdict === FAIL);
  const unknown = sorted.filter(row => row.verdict === UNKNOWN);

  console.log('宪章 · 交互门禁（charter-ux-audit）');
  console.log('判据来源：spec/01-顶层宪章-v1.0.md · spec/03-功能与交互设计-v1.0.md · spec/02-VI规范-v1.0.md');
  console.log('夹具：内存库 + 演示数据（绝不碰生产库）;截图目录 prototype/screenshots/charter-ux/');
  console.log('');
  for (const row of sorted) {
    console.log('[' + (row.verdict === PASS ? '合规' : row.verdict === FAIL ? '违规' : '存疑') + '] ' + row.id + ' · ' + row.criterion);
    console.log('   判据：' + row.criterionText);
    console.log('   实测：' + row.measured);
    if (row.evidence) console.log('   证据：' + row.evidence);
    console.log('');
  }
  console.log(`合计 ${sorted.length} 条判据：合规 ${sorted.length - failed.length - unknown.length} · 违规 ${failed.length} · 无法机械判定 ${unknown.length}`);
  if (failed.length) console.log('违规：' + failed.map(row => row.id).join('、'));
  if (unknown.length) console.log('存疑：' + unknown.map(row => row.id).join('、'));

  // 便于后续加工的报告文件（人看的 Markdown 版由交付报告给出）
  writeFileSync(shots + 'result.json', JSON.stringify({checks: sorted, steps, latency: latencyRows, deadNumbers, followUps, surpriseDialogs, colorOnly, purpleMisuse}, null, 1));

  // 基线（与 style-check 同一套做法）：**已知债务照常列出，新增债务才拦**。
  // 这不是放宽判据 —— 判据一条没改，改的是"红的条件"：从"存在违规"变成"出现了新违规"。
  // 还掉一条就从基线里删一条；基线里写了却没违规的，也会被报出来（避免基线腐烂）。
  const baselinePath = new URL('./charter-ux-baseline.json', import.meta.url);
  const knownIds = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')).ids ?? []) : [];
  const newViolations = failed.map(row => row.id).filter(id => !knownIds.includes(id));
  const repaidIds = knownIds.filter(id => !failed.some(row => row.id === id));
  // 只报**真的在基线里**的那些。以前这里用的是 failed.length（全部违规），
  // 于是被拦下的新违规也被写成"已在基线里，不拦" —— 门禁自己说假话，比没有门禁更坏。
  const knownFailed = failed.filter(row => knownIds.includes(row.id));
  if (knownFailed.length) {
    console.log('  已知债务 ' + knownFailed.length + ' 条（已在基线里，不拦）：' + knownFailed.map(row => row.id).join('、'));
  }
  if (repaidIds.length) console.log('  基线里这些已经还掉了，请从 prototype/charter-ux-baseline.json 删掉：' + repaidIds.join('、'));
  if (newViolations.length) console.log('  新增违规（拦下）：' + newViolations.join('、'));
  process.exit(newViolations.length ? 1 : 0);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}
