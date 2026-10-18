#!/usr/bin/env node
/** 宪章判据 4：**换模型、换 Agent，事实与治理不重来**。
 *
 *  这条判据以前在账本里被写成"架构事实，无可跑的判据" —— 其实可以验，而且值得验：
 *  它要回答的是"**换一个 Agent 来干活，之前的事实和治理记录还在不在、是不是同一套**"。
 *
 *  怎么验（对着真实库的副本，写完就丢，不碰真库）：
 *    ① 事实不重来：Agent A 写进去的东西，Agent B（**不同会话、不同适配器实例**）立刻看得到，
 *       而且两边读到的数量完全一致；
 *    ② 治理不重来：两个 Agent 各自写的改动，在 `audit` / `batches` 里的**事件名与状态形状一致**
 *       （不会因为换了 Agent 就多出一套说法）；
 *    ③ 没有内存态：**另起一个进程**再读一次同一个库，数字与刚才一致 ——
 *       说明事实与治理只住在库里，不在某个 Agent 的会话里（这也就是"换模型"为什么不影响它：
 *       插件从头到尾看不到模型，只有库）。
 *
 *  用法：node prototype/agent-swap-check.mjs [库路径]
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? join(here, '..', '..', 'workstation-data', 'workstation.sqlite');
if (!existsSync(source)) {
  console.log('FAIL: 找不到真实库：' + source + '（不是通过，是没测到）');
  process.exit(1);
}

const problems = [];
const check = (label, ok, evidence = '') => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (evidence ? '  → ' + String(evidence).slice(0, 130) : ''));
  if (!ok) problems.push(label);
};

const workdir = mkdtempSync(join(tmpdir(), 'agent-swap-'));
const copy = join(workdir, 'copy.sqlite');
execFileSync('/usr/bin/sqlite3', [source, '.backup ' + copy]);   // WAL 安全的只读副本（写完就丢）

const WORKSPACE = {id: 'w', title: '个人空间', path: '/tmp/agent-swap-workspace'};
const sessions = new Map([
  ['agent-A-session', {header: {cwd: WORKSPACE.path}}],
  ['agent-B-session', {header: {cwd: WORKSPACE.path}}],
]);
const makeAdapter = store => new DshAdapter({
  store,
  sessions: {get: id => sessions.get(id) ?? null},
  workspaceRegistry: {resolveByPath: async path => (path === WORKSPACE.path ? WORKSPACE : null), get: id => (id === WORKSPACE.id ? WORKSPACE : null)},
  allowedWorkspaces: [WORKSPACE.id],
  approval: {request: async () => 'allowed-once'},
});
const call = (adapter, agentId) => (action, args = {}) => adapter.run({action, ...args}, {agent: {id: agentId}, callId: 'call-1'});
const counts = db => {
  const handle = new DatabaseSync(db, {readOnly: true});
  try {
    const one = sql => handle.prepare(sql).get().c;
    return {
      entities: one('select count(*) c from entities'),
      judgments: one("select count(*) c from entities where kind='judgment'"),
      batches: one('select count(*) c from batches'),
      audit: one('select count(*) c from audit'),
    };
  } finally { handle.close(); }
};

try {
  // ── ① 事实不重来：两个 Agent 看同一批事实 ────────────────────────────────
  const storeA = new WorkstationStore(copy);
  const agentA = makeAdapter(storeA);
  const A = call(agentA, 'agent-A-session');
  const listedByA = await A('list', {kind: 'judgment', limit: 100});
  const before = counts(copy);
  console.log('库里的起点：对象 ' + before.entities + ' · 判断 ' + before.judgments + ' · 批次 ' + before.batches + ' · 留痕 ' + before.audit);

  // 另起一个**完全独立的适配器实例**，代表"换了一个 Agent"
  const storeB = new WorkstationStore(copy);
  const agentB = makeAdapter(storeB);
  const B = call(agentB, 'agent-B-session');
  const listedByB = await B('list', {kind: 'judgment', limit: 100});
  check('两个 Agent 看到的事实完全一致（条数）', listedByA.items?.length === listedByB.items?.length, 'A=' + (listedByA.items?.length ?? '?') + ' · B=' + (listedByB.items?.length ?? '?'));
  const idsA = (listedByA.items ?? []).map(row => row.id).sort().join(',');
  const idsB = (listedByB.items ?? []).map(row => row.id).sort().join(',');
  check('两个 Agent 看到的是**同一条条**（不是各自编的）', idsA === idsB && idsA.length > 0, idsA.slice(0, 60) + '…');

  // ── ② 治理不重来：B 写一条，A 立刻看得到，且治理形状一致 ─────────────────
  const eventsBefore = (() => { const handle = new DatabaseSync(copy, {readOnly: true}); try { return handle.prepare('select distinct event from audit').all().map(row => row.event); } finally { handle.close(); } })();
  const draft = await B('draft', {title: '判据 4 验收：换 Agent 之后写的一条', changes: [
    {op: 'create', id: 'swap-check-1', kind: 'project', data: {title: '换 Agent 之后仍然记在同一本账上'}},
  ]});
  const batchId = draft.batchId ?? draft.batch?.id ?? draft.id;
  check('Agent B 的改动进了**同一个收件箱**（不是它自己的）', Boolean(batchId), String(batchId ?? draft).slice(0, 60));
  // Agent 通道的动作名是 commit（不是 apply）；approval 已在桩里给过 allowed-once
  await B('commit', {id: batchId, revision: draft.revision ?? 1, key: 'swap-check'});

  const readByA = await A('get', {id: 'swap-check-1'});
  check('Agent A 立刻读得到 Agent B 写的事实（事实不重来）', (readByA.item?.data?.title ?? '') === '换 Agent 之后仍然记在同一本账上', String(readByA.item?.data?.title ?? '（读不到）'));

  const handle = new DatabaseSync(copy, {readOnly: true});
  const auditEvents = handle.prepare("select event, count(*) c from audit group by event order by event").all();
  const batchStatuses = handle.prepare('select status, count(*) c from batches group by status order by status').all();
  const agentRows = handle.prepare("select count(*) c from batches where body like '%判据 4 验收%'").get().c;
  handle.close();
  console.log('治理记录：' + auditEvents.map(row => row.event + '×' + row.c).join(' · '));
  console.log('批次状态：' + batchStatuses.map(row => row.status + '×' + row.c).join(' · '));
  // 判据的正确写法：**不是**我预先猜一份白名单（第一版就是这么写的，猜错了当场变红），
  // 而是"换 Agent 之后有没有冒出**新的事件类型**" —— 治理的说法必须还是原来那一套。
  const eventsAfter = auditEvents.map(row => row.event);
  const introduced = eventsAfter.filter(event => !eventsBefore.includes(event));
  check('换 Agent 之后没有冒出新的事件类型（治理还是同一套说法）', introduced.length === 0, '原有 ' + eventsBefore.join(',') + ' · 新增 ' + (introduced.join(',') || '无'));
  check('B 写的这批进了同一张 batches 表', agentRows >= 1, '命中 ' + agentRows + ' 条');
  storeA.close();
  storeB.close();

  // ── ③ 没有内存态：**另起一个进程**再读一次 ──────────────────────────────
  const after = counts(copy);
  const probe = execFileSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(${JSON.stringify(copy)},{readOnly:true});
    const one=s=>db.prepare(s).get().c;
    process.stdout.write(JSON.stringify({entities:one('select count(*) c from entities'),judgments:one("select count(*) c from entities where kind='judgment'"),batches:one('select count(*) c from batches'),audit:one('select count(*) c from audit')}));
    db.close();
  `], {encoding: 'utf8'});
  const fresh = JSON.parse(probe);
  check('另起进程读同一个库，数字一致（事实与治理不住在某个 Agent 的会话里）',
    JSON.stringify(fresh) === JSON.stringify(after),
    '进程内 ' + JSON.stringify(after) + ' · 新进程 ' + JSON.stringify(fresh));
  check('B 写的那条在库里（换 Agent 不丢）', after.entities === before.entities + 1, before.entities + ' → ' + after.entities);
} catch (error) {
  problems.push('验收过程本身出错：' + (error?.message ?? error));
} finally {
  rmSync(workdir, {recursive: true, force: true});
}

if (problems.length) {
  console.log('FAIL: ' + problems.length + ' 项没通过 —— ' + problems.join('；'));
  process.exit(1);
}
console.log('PASS：换 Agent 之后，事实与治理都还在同一本账上（判据 4 成立）。');
console.log('（"换模型"这一半同理：插件从头到尾看不到模型，只认库 —— 这也是上面"另起进程数字一致"要证明的。）');
