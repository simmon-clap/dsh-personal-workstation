import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {buildAdvice, stageAdvanceAdvice} from '../src/advice.mjs';

const ctx = {workspace: 'w', actor: 'operator', canWrite: true};
/** 建一个项目：交付项全部完成、阶段停在「验证」。 */
function seeded({deliverables = [{id: 'd1', title: '芯片到货', done: true}, {id: 'd2', title: '跑通 decode', done: true}], stage = '验证'} = {}) {
  const store = new WorkstationStore(':memory:');
  store.draft(ctx, {title: '建项目', changes: [{op: 'create', id: 'p1', kind: 'project',
    data: {title: '示例科技 · 3D 存算一体', stage, deliverables}}]});
  store.commit(ctx, {batchId: store.inbox(ctx, {status: 'draft'})[0].id, revision: 1, key: 'k1'});
  return store;
}

// 宪章四：建议必须带**依据**与**不确定性**，而且只能进收件箱等人决定 —— 不许直接落库。
test('a completed project produces a stage suggestion with evidence and uncertainty, into the inbox', () => {
  const store = seeded();
  const before = store.get(ctx, 'p1');
  const {suggestions, drafted} = buildAdvice({store, ctx, now: new Date('2026-10-14T00:00:00Z')});
  assert.equal(suggestions.length, 1, '交付项全完成、阶段没走完，就该提一条建议');
  const [item] = suggestions;
  assert.equal(item.next, '复盘');
  assert.ok(item.proposal.evidence.length >= 2, '依据要逐条给出是哪几项完成了，不能只给结论');
  assert.match(item.proposal.evidence[0].quote, /已完成/);
  assert.ok(item.proposal.uncertainty.length > 0, '必须带不确定性');
  assert.equal(drafted.length, 1, '要写进收件箱');

  // ① 没有直接落库：项目阶段原地不动
  assert.equal(store.get(ctx, 'p1').data.stage, before.data.stage, '机器不许替你改阶段');
  // ② 它躺在待决定里，并且作者是 agent（契约②：谁发起决定要不要确认）
  const inbox = store.inbox(ctx, {status: 'draft'});
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'agent');
  assert.ok(inbox[0].proposal, '收件箱里这条要能渲染成建议（依据 / 不确定性 / 回应）');
  // ③ 同意之后才真的生效
  store.commit(ctx, {batchId: inbox[0].id, revision: inbox[0].revision, key: 'advice-1'});
  assert.equal(store.get(ctx, 'p1').data.stage, '复盘', '同意之后才推进');
  assert.equal(store.get(ctx, 'p1').data.stageHistory.at(-1).stage, '复盘');
});

// 宪章六·安静：结论没成立时不许提 —— "还有活没干完，建议推进"是噪音。
test('no suggestion while work is unfinished, and none after the last stage', () => {
  const unfinished = seeded({deliverables: [{id: 'd1', title: '芯片到货', done: true}, {id: 'd2', title: '跑通 decode', done: false}]});
  assert.equal(stageAdvanceAdvice({store: unfinished, ctx}).length, 0, '还有交付项没完成就不该提');
  const last = seeded({stage: '复盘'});
  assert.equal(stageAdvanceAdvice({store: last, ctx}).length, 0, '已经是最后一个阶段就没什么可推进的');
  const none = seeded({deliverables: []});
  assert.equal(stageAdvanceAdvice({store: none, ctx}).length, 0, '没有交付项就无从判断"做完了"');
});

// 同一条建议不要天天提（否则收件箱会被同一件事刷满）。
test('the same suggestion is not proposed twice while it is still waiting', () => {
  const store = seeded();
  buildAdvice({store, ctx});
  const second = buildAdvice({store, ctx});
  assert.equal(second.drafted.length, 0, '已经有一条待决定的同类建议时不再重复提');
  assert.equal(store.inbox(ctx, {status: 'draft'}).length, 1);
});
