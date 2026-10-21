import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {BeatStore, judgeBeat, BEAT_INTERVAL_MINUTES, STALE_FACTOR} from '../src/beat-store.mjs';

/** 常驻节点心跳（宪章 v1.4 第七条 · 13 §10 · 17 C8 v1.1）的验收：
 *  - 判活是**记账**，不是探活：只看"最后一条心跳",不看网络；
 *  - 承诺不对称：只有常驻那一侧判红；
 *  - 时间读不懂时**不许**当成"它还醒着"（宁可疑，不许假绿）。 */
const ctx = {workspace: 'w', actor: 'u', canWrite: true};

test('判活：按时心跳算醒着，逾期算停', () => {
 const now = new Date('2026-10-21T12:00:00Z');
 const ok = judgeBeat({lastAt: '2026-10-21T11:50:00Z', now});
 assert.equal(ok.state, 'ok');
 assert.equal(ok.silentMinutes, 10);

 const stale = judgeBeat({lastAt: '2026-10-21T09:00:00Z', now});
 assert.equal(stale.state, 'stale');
 assert.equal(stale.silentMinutes, 180);
 assert.equal(stale.staleAfterMinutes, BEAT_INTERVAL_MINUTES * STALE_FACTOR);
 assert.match(stale.note, /没有心跳/);
});

test('判活：一次都没记过 = never，不是 ok', () => {
 const judged = judgeBeat({lastAt: null, now: new Date('2026-10-21T12:00:00Z')});
 assert.equal(judged.state, 'never');
 assert.equal(judged.silentMinutes, null);
});

test('判活：时间读不懂不许当成醒着（防止假绿）', () => {
 const judged = judgeBeat({lastAt: '不是时间', now: new Date('2026-10-21T12:00:00Z')});
 assert.equal(judged.state, 'never');
 assert.match(judged.note, /读不懂/);
});

test('心跳表：seq 单调递增，last 取最新一条', () => {
 const store = new WorkstationStore(':memory:');
 const beat = new BeatStore(store);
 try {
  const a = beat.append(ctx, {side: 'resident', at: '2026-10-21T10:00:00Z', source: 'timer'});
  const b = beat.append(ctx, {side: 'resident', at: '2026-10-21T10:15:00Z', source: 'timer'});
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  const last = beat.last(ctx, {side: 'resident'});
  assert.equal(last.seq, 2);
  assert.equal(last.at, '2026-10-21T10:15:00Z');
 } finally {
  store.close();
 }
});

test('心跳表：两侧各自计数，互不影响', () => {
 const store = new WorkstationStore(':memory:');
 const beat = new BeatStore(store);
 try {
  beat.append(ctx, {side: 'resident', at: '2026-10-21T10:00:00Z'});
  const laptop = beat.append(ctx, {side: 'laptop', at: '2026-10-21T10:05:00Z'});
  assert.equal(laptop.seq, 1, '笔记本的心跳不该接着常驻节点的序号往下排');
 } finally {
  store.close();
 }
});

test('心跳表：时间非法直接拒绝，不写脏数据', () => {
 const store = new WorkstationStore(':memory:');
 const beat = new BeatStore(store);
 try {
  assert.throws(() => beat.append(ctx, {at: '昨天'}), /心跳时间无效/);
  assert.throws(() => beat.append(ctx, {side: ''}), /哪一侧/);
 } finally {
  store.close();
 }
});

test('state：常驻侧两小时没心跳要判成停，并把最后一条时间交出来', () => {
 const store = new WorkstationStore(':memory:');
 const beat = new BeatStore(store);
 try {
  beat.append(ctx, {side: 'resident', at: '2026-10-21T10:00:00Z'});
  const state = beat.state(ctx, {residentSide: 'resident', now: new Date('2026-10-21T12:00:00Z')});
  assert.equal(state.state, 'stale');
  assert.equal(state.fault, true);
  assert.equal(state.lastBeatAt, '2026-10-21T10:00:00Z');
 } finally {
  store.close();
 }
});

test('配置：assistant 默认不判活，beatMinutes 夹在 1–120', async () => {
 const {resolveConfig} = await import('../src/index.mjs');
 const base = {dataDirectory: '/tmp/ws', allowedWorkspaces: ['w']};
 const plain = resolveConfig(base);
 assert.equal(plain.assistant.residentNode, false, '默认必须是"本机不判活"，否则笔记本会凭空报故障');
 assert.equal(plain.assistant.beatMinutes, 15);

 const on = resolveConfig({...base, assistant: {residentNode: true, beatMinutes: 999}});
 assert.equal(on.assistant.residentNode, true);
 assert.equal(on.assistant.beatMinutes, 120, '心跳间隔要夹住，否则"每 999 分钟一次"等于不判活');

 const zero = resolveConfig({...base, assistant: {beatMinutes: 0}});
 assert.equal(zero.assistant.beatMinutes, 15);
});
