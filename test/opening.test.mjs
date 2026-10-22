import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {HeartbeatStore} from '../src/heartbeat-store.mjs';
import {LoopStore} from '../src/loop-store.mjs';
import {OpeningStore} from '../src/opening-store.mjs';
import {shouldOpen, runOpening} from '../src/assistant.mjs';

/** 开口点（spec/55 P3）的验收：
 *  - 一天一个锚点只开口一次（重复触发不许催促）；
 *  - 开口记录必须同时留下"说了什么"和"为什么没说"；
 *  - 不是开口点就不开口。 */
const ctx = {workspace: 'w', actor: 'u', canWrite: true};
const MORNING = new Date('2026-10-22T09:35:00+08:00');
const NOON = new Date('2026-10-22T13:00:00+08:00');

function setup() {
 const store = new WorkstationStore(':memory:');
 const heartbeat = new HeartbeatStore(store);
 const loop = new LoopStore(store);
 const openings = new OpeningStore(store);
 const create = (title, changes) => {
  const batch = store.draft(ctx, {title, changes});
  return store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: title + Math.random()});
 };
 return {store, heartbeat, loop, openings, create};
}

test('不是开口点就不开口', async () => {
 const {store, openings} = setup();
 try {
  const decision = shouldOpen({openings, ctx, now: NOON});
  assert.equal(decision.open, false);
  assert.match(decision.why, /不是开口点/);
 } finally { store.close(); }
});

test('到点 + 今天没开过 → 开口一次，并留下说了什么/为什么没说', async () => {
 const {store, heartbeat, loop, openings, create} = setup();
 try {
  create('建任务', [{op: 'create', id: 'a', kind: 'task', data: {title: '交周报', dueDate: '2026-10-22', status: 'todo'}}]);
  const result = await await runOpening({store, ctx, heartbeat, loop, openings, now: MORNING});
  assert.equal(result.opened, true);
  assert.equal(result.anchor, 'morning');
  assert(Array.isArray(result.opening.items));
  assert(Array.isArray(result.opening.skipped));
  // 至少有一条候选被"没说出来"的原因覆盖（比如缺三问）
  assert(result.opening.items.length + result.opening.skipped.length >= 1);
 } finally { store.close(); }
});

test('同一个锚点再触发：不催促，也不改写已有记录', async () => {
 const {store, heartbeat, loop, openings} = setup();
 try {
  const first = await await runOpening({store, ctx, heartbeat, loop, openings, now: MORNING});
  const again = await runOpening({store, ctx, heartbeat, loop, openings, now: new Date('2026-10-22T09:40:00+08:00')});
  assert.equal(first.opened, true);
  assert.equal(again.opened, false);
  assert.match(again.why, /已经开过口/);
  assert.equal(openings.list(ctx).length, 1);
 } finally { store.close(); }
});

test('开口记录按天+锚点唯一：第二天同一锚点可以再开', async () => {
 const {store, heartbeat, loop, openings} = setup();
 try {
  await runOpening({store, ctx, heartbeat, loop, openings, now: MORNING});
  const nextDay = await runOpening({store, ctx, heartbeat, loop, openings, now: new Date('2026-10-23T09:35:00+08:00')});
  assert.equal(nextDay.opened, true);
  assert.equal(openings.list(ctx).length, 2);
 } finally { store.close(); }
});

test('开口记录说清缺哪一问（判断层筛掉的原因要能回看）', () => {
 const {store, openings} = setup();
 try {
  const saved = openings.record(ctx, {anchor: 'evening', items: [], skipped: [{id: 'x', rule: '守承诺', why: '缺「能做什么」'}], summary: '没有值得现在说的'});
  assert.equal(saved.skipped[0].why, '缺「能做什么」');
  assert.equal(openings.openedToday(ctx, {anchor: 'evening', now: new Date(saved.at)}), true);
 } finally { store.close(); }
});
