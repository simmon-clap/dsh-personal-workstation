import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {buildBriefing, daysUntil} from '../src/briefing.mjs';

const ctx = {workspace: 'w', actor: 'operator', canWrite: true};
const now = new Date('2026-10-15T09:30:00+08:00');

function seeded(changes) {
  const store = new WorkstationStore(':memory:');
  store.draft(ctx, {title: '夹具', changes});
  store.commit(ctx, {batchId: store.inbox(ctx, {status: 'draft'})[0].id, revision: 1, key: 'k'});
  return store;
}

test('简报只报"你不知道就会有损失"的事，而且每条都要能回答"为什么现在告诉你"', () => {
  const store = seeded([
    {op: 'create', id: 't-due', kind: 'task', data: {title: '索取开发板', status: 'todo', dueDate: '2026-10-15'}},
    {op: 'create', id: 't-far', kind: 'task', data: {title: '下季度的调研', status: 'todo', dueDate: '2026-12-01'}},
    {op: 'create', id: 't-stuck', kind: 'task', data: {title: '试点范围跟进', status: 'waiting'}},
  ]);
  const briefing = buildBriefing({store, ctx, now, since: new Date('2026-10-15T00:00:00+08:00')});
  assert.equal(briefing.empty, false);

  // 到期的进来，还早的不进来（克制：不报"还有 47 天"这种东西）
  const due = briefing.sections.find(s => s.kind === 'due');
  assert.ok(due, '今天到期的任务必须进简报');
  assert.ok(due.items.some(i => i.subjectId === 't-due'));
  assert.ok(!briefing.sections.some(s => s.items.some(i => i.subjectId === 't-far')), '还早的任务不该出现');

  // 卡住的：没写原因就如实说"没写"，不编一个原因
  const stuck = briefing.sections.find(s => s.kind === 'stuck');
  assert.ok(stuck.items.some(i => /没写等待原因/.test(i.why)));

  // 每条三件套齐全：结论 / 为什么现在 / 依据 / 一个动作
  for (const section of briefing.sections) {
    for (const item of section.items) {
      assert.ok(item.what && item.why && item.action, '每条都要有结论、为什么现在、一个动作：' + JSON.stringify(item));
      assert.ok(Array.isArray(item.evidence) && item.evidence.length, '每条都要有可核对的依据');
    }
  }
});

test('没有要报的事就不生成简报 —— 不产出空简报（宪章六·安静）', () => {
  const store = seeded([{op: 'create', id: 't-far', kind: 'task', data: {title: '很远的事', status: 'todo', dueDate: '2027-06-01'}}]);
  const briefing = buildBriefing({store, ctx, now, since: new Date('2026-10-15T00:00:00+08:00')});
  assert.equal(briefing.empty, true);
  assert.equal(briefing.sections.length, 0);
  assert.match(briefing.headline, /没什么要你处理/);
});

test('期间保持只报增量：上次简报之前的东西不再出现', () => {
  const store = seeded([{op: 'create', id: 't-old', kind: 'topic', data: {title: '老议题', description: '很久以前'}}]);
  // 上次简报在这条之后 → 它不是"新进展"
  const later = buildBriefing({store, ctx, now, since: new Date(Date.now() + 60_000)});
  assert.ok(!later.sections.some(s => s.kind === 'fresh'), '上次简报之后没有新东西，就不该有"有新东西"这一段');
});

test('daysUntil 把日期差异算对（今天=0 / 明天=1 / 过期=负）', () => {
  assert.equal(daysUntil('2026-10-15', now), 0);
  assert.equal(daysUntil('2026-10-16', now), 1);
  assert.equal(daysUntil('2026-10-13', now), -2);
  assert.equal(daysUntil('', now), null);
});
