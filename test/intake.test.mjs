import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {IntakeStore, INTAKE_STATES, INTAKE_SOURCES} from '../src/intake-store.mjs';

/** 收件本（宪章 v1.4 第二条「事事有回应」· spec/03 §13 · spec/55 P1）的验收：
 *  - 每条输入都落一行，状态只有三个，没有"处理中"；
 *  - 不打扰你、需要你一句话，**必须写理由**（否则就是黑箱）；
 *  - 归不上要显式标"未归属"，不许假装归属完成（F3）。 */
const ctx = {workspace: 'w', actor: 'u', canWrite: true};
const NOW = new Date('2026-10-22T10:00:00+08:00');

function setup() {
 const store = new WorkstationStore(':memory:');
 return {store, intake: new IntakeStore(store)};
}

test('记下了：带归属的一条，落进收件本且当场有结论', () => {
 const {store, intake} = setup();
 try {
  const row = intake.append(ctx, {source: 'page', summary: '新建项目：家庭网络改造', subjectKind: 'project', subjectId: 'proj-1', at: NOW.toISOString()});
  assert.equal(row.state, 'captured');
  assert.equal(row.unassigned, false);
  assert.equal(row.subjectId, 'proj-1');
  assert.equal(intake.list(ctx).length, 1);
 } finally { store.close(); }
});

test('归不上：显式标未归属，能在「没人接」里被列出来', () => {
 const {store, intake} = setup();
 try {
  intake.append(ctx, {source: 'chat', summary: '客户说下周再谈', at: NOW.toISOString()});
  const [item] = intake.open(ctx, {now: NOW});
  assert.equal(item.unassigned, true);
  assert.equal(item.state, 'captured');
 } finally { store.close(); }
});

test('不打扰你 / 需要你一句话：不写理由就拒收', () => {
 const {store, intake} = setup();
 try {
  assert.throws(() => intake.append(ctx, {source: 'mail', summary: '一封广告', state: 'not_mine'}),
   /必须写清理由/);
  assert.throws(() => intake.append(ctx, {source: 'voice', summary: '录音一段', state: 'needs_you'}),
   /必须写清理由/);
  // 写了理由就能收
  const ok = intake.append(ctx, {source: 'mail', summary: '一封广告', state: 'not_mine', reason: '推广邮件'});
  assert.equal(ok.state, 'not_mine');
 } finally { store.close(); }
});

test('状态只有三个：编一个第四种要被拒绝', () => {
 const {store, intake} = setup();
 try {
  assert.throws(() => intake.append(ctx, {source: 'page', summary: 'x', state: 'processing'}), /状态只能是/);
  assert.deepEqual(INTAKE_STATES, ['captured', 'not_mine', 'needs_you']);
 } finally { store.close(); }
});

test('来路必须是登记过的九个口之一', () => {
 const {store, intake} = setup();
 try {
  assert.throws(() => intake.append(ctx, {source: 'telepathy', summary: 'x'}), /不认识的来路/);
  for (const source of INTAKE_SOURCES) {
   const row = intake.append(ctx, {source, summary: '来自 ' + source, state: 'not_mine', reason: '测试'});
   assert.equal(row.source, source);
  }
 } finally { store.close(); }
});

test('空内容与超长摘要都不收（不许收一条说不清的）', () => {
 const {store, intake} = setup();
 try {
  assert.throws(() => intake.append(ctx, {source: 'page', summary: '   '}), /没有内容/);
  assert.throws(() => intake.append(ctx, {source: 'page', summary: 'x'.repeat(201)}), /200 字/);
 } finally { store.close(); }
});

test('事后补归属：补一次就关单，再补要报冲突', () => {
 const {store, intake} = setup();
 try {
  const row = intake.append(ctx, {source: 'page', summary: '不知道归哪'});
  const assigned = intake.assign(ctx, row.id, {subjectKind: 'task', subjectId: 'task-9'});
  assert.equal(assigned.unassigned, false);
  assert.equal(assigned.subjectId, 'task-9');
  assert.throws(() => intake.assign(ctx, row.id, {subjectId: 'task-10'}), /已经归属过了/);
  assert.equal(intake.open(ctx).length, 0);
 } finally { store.close(); }
});

test('需要你一句话挂太久：标成 overdue，而不是悄悄消失', () => {
 const {store, intake} = setup();
 try {
  intake.append(ctx, {source: 'im', summary: '要不要接这个活', state: 'needs_you', reason: '等你决定',
   at: '2026-10-20T10:00:00+08:00'});
  const [item] = intake.open(ctx, {now: NOW, waitingHours: 24});
  assert.equal(item.overdue, true);
 } finally { store.close(); }
});

test('今日汇总：四个数对得上明细', () => {
 const {store, intake} = setup();
 try {
  intake.append(ctx, {source: 'page', summary: '甲', subjectKind: 'project', subjectId: 'p1', at: NOW.toISOString()});
  intake.append(ctx, {source: 'chat', summary: '乙', at: NOW.toISOString()});
  intake.append(ctx, {source: 'mail', summary: '丙', state: 'not_mine', reason: '推广', at: NOW.toISOString()});
  intake.append(ctx, {source: 'voice', summary: '丁', state: 'needs_you', reason: '等你确认', at: NOW.toISOString()});
  const summary = intake.summary(ctx, {now: NOW});
  assert.equal(summary.today, 4);
  assert.equal(summary.unassigned, 1);
  assert.equal(summary.notMine, 1);
  assert.equal(summary.needsYou, 1);
  assert.equal(summary.captured, 2);
 } finally { store.close(); }
});
