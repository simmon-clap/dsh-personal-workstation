import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {LoopStore, LOOP_STATES} from '../src/loop-store.mjs';
import {runHeartbeat} from '../src/heartbeat.mjs';

/** 着落本（宪章 v1.4 第二条「件件有着落」· spec/55 P2）的验收：
 *  - 四档终态齐全；
 *  - 「在等谁」必须同时说清等谁 + 等到什么时候（没有期限 = 永久悬案）；
 *  - 等超期、以及到期没有着落的，都要能被扫出来。 */
const ctx = {workspace: 'w', actor: 'u', canWrite: true};
const NOW = new Date('2026-10-22T10:00:00+08:00');

function setup() {
 const store = new WorkstationStore(':memory:');
 const create = (title, changes) => {
  const batch = store.draft(ctx, {title, changes});
  return store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: title + Math.random()});
 };
 return {store, loop: new LoopStore(store), create};
}

test('四档终态：完成 / 放弃 / 转出 都不许带"在等"字段', () => {
 const {store, loop} = setup();
 try {
  assert.deepEqual(LOOP_STATES, ['done', 'dropped', 'handed_off', 'waiting']);
  for (const state of ['done', 'dropped', 'handed_off']) {
   const row = loop.close(ctx, {subjectKind: 'task', subjectId: 't-' + state, state});
   assert.equal(row.state, state);
   assert.equal(row.closedAt, row.openedAt, '有终态就地结案');
  }
  assert.throws(() => loop.close(ctx, {subjectKind: 'task', subjectId: 't-x', state: 'done', waitingFor: '客户'}),
   /不是「在等谁」/);
 } finally { store.close(); }
});

test('在等谁：缺"等谁"或缺"等到什么时候"都拒收', () => {
 const {store, loop} = setup();
 try {
  assert.throws(() => loop.close(ctx, {subjectKind: 'task', subjectId: 't1', state: 'waiting', waitingUntil: '2026-11-01'}),
   /必须写清在等谁/);
  assert.throws(() => loop.close(ctx, {subjectKind: 'task', subjectId: 't2', state: 'waiting', waitingFor: '客户'}),
   /等到什么时候/);
  assert.throws(() => loop.close(ctx, {subjectKind: 'task', subjectId: 't3', state: 'waiting', waitingFor: '客户', waitingUntil: '下周'}),
   /等到什么时候/);
  const ok = loop.close(ctx, {subjectKind: 'task', subjectId: 't4', state: 'waiting', waitingFor: '客户', waitingUntil: '2026-11-01'});
  assert.equal(ok.closedAt, null, '在等谁不算结案：事还没完，只是有主了');
 } finally { store.close(); }
});

test('同一件事只留一条着落：再写是更新，不是第二条说法', () => {
 const {store, loop} = setup();
 try {
  loop.close(ctx, {subjectKind: 'task', subjectId: 't1', state: 'waiting', waitingFor: '客户', waitingUntil: '2026-11-01'});
  loop.close(ctx, {subjectKind: 'task', subjectId: 't1', state: 'done', note: '客户回信了'});
  assert.equal(loop.list(ctx).length, 1);
  assert.equal(loop.forSubject(ctx, {subjectKind: 'task', subjectId: 't1'}).state, 'done');
 } finally { store.close(); }
});

test('扫描：等超期要列出来，说清在等谁', () => {
 const {store, loop} = setup();
 try {
  loop.close(ctx, {subjectKind: 'task', subjectId: 't1', state: 'waiting', waitingFor: '客户确认', waitingUntil: '2026-10-20T00:00:00+08:00'});
  loop.close(ctx, {subjectKind: 'task', subjectId: 't2', state: 'waiting', waitingFor: '领导', waitingUntil: '2026-11-20T00:00:00+08:00'});
  const {overdue} = loop.sweep(ctx, {now: NOW});
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].subjectId, 't1');
  assert.match(overdue[0].reason, /已经过了/);
 } finally { store.close(); }
});

test('扫描：到期三天还没着落的任务要被列出来；已经有着落的不再催', () => {
 const {store, loop, create} = setup();
 try {
  create('建三个任务', [
   {op: 'create', id: 'a', kind: 'task', data: {title: '早该有结论的', dueDate: '2026-10-10', status: 'in_progress'}},
   {op: 'create', id: 'b', kind: 'task', data: {title: '刚到期还没到催的时候', dueDate: '2026-10-21', status: 'todo'}},
   {op: 'create', id: 'c', kind: 'task', data: {title: '已经有着落的', dueDate: '2026-10-01', status: 'todo'}},
  ]);
  loop.close(ctx, {subjectKind: 'task', subjectId: 'c', state: 'handed_off', note: '交给小王'});
  const tasks = store.list(ctx, {kind: 'task', limit: 100});
  const {unlanded} = loop.sweep(ctx, {now: NOW, subjects: tasks.map(t => ({kind: 'task', id: t.id, title: t.data.title, dueDate: t.data.dueDate}))});
  assert.deepEqual(unlanded.map(item => item.subjectId), ['a']);
  assert.match(unlanded[0].reason, /还没有着落/);
 } finally { store.close(); }
});

test('心跳规则「看落实」：超期悬案进候选，没接入着落本要如实说', () => {
 const {store, loop, create} = setup();
 try {
  create('建任务', [{op: 'create', id: 'a', kind: 'task', data: {title: '早该有结论的', dueDate: '2026-10-10', status: 'in_progress'}}]);
  const withLoop = runHeartbeat({store, ctx, now: NOW, loop});
  const verdict = withLoop.candidates.filter(item => item.rule === '看落实');
  assert.equal(verdict.length, 1, '到期没着落的任务应当进候选');
  assert.match(verdict[0].why, /没有着落/);

  const withoutLoop = runHeartbeat({store, ctx, now: NOW, loop: null});
  assert(withoutLoop.silenced.some(item => item.what === '着落本' && /还没接入/.test(item.why)),
   '没接入就要如实说，不能假装看过');
 } finally { store.close(); }
});
