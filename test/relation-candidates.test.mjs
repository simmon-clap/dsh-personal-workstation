import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relationCandidates} from '../src/relation-candidates.mjs';

const mk = (id, kind, data) => ({id, kind, data, archived: false});

test('候选只提"还没连上"的对：已有派生关系与已否决过的不再提', () => {
  const entities = [
    mk('p1', 'project', {title: '示例客户合作'}),
    mk('t1', 'task', {title: '跟进接口', projectId: 'p1'}),      // 已派生 → t1 与 p1 不该出现
    mk('t2', 'task', {title: '接口联调'}),
    mk('r1', 'relation', {from: 't2', to: 'p1', status: 'rejected', evidence: '否决过'}),
  ];
  const rows = relationCandidates(entities);
  const pairs = rows.map(r => [r.from, r.to].sort().join('+'));
  assert.ok(!pairs.includes(['p1', 't1'].sort().join('+')), '已派生的关系不该当候选');
  assert.ok(!pairs.includes(['p1', 't2'].sort().join('+')), '被否决过的不许再提');
});

test('每条候选都要带"凭什么提它"，没信号的对一条都不提', () => {
  const entities = [
    mk('a1', 'artifact', {title: '会议纪要', folder: '示例客户'}),
    mk('a2', 'artifact', {title: '技术要点', folder: '示例客户'}),
    mk('x1', 'artifact', {title: '完全无关甲', folder: '别的'}),
    mk('x2', 'artifact', {title: '完全无关乙', folder: '另一个'}),
  ];
  const rows = relationCandidates(entities);
  for (const row of rows) assert.ok(row.reason && row.reason.trim(), '候选必须带依据：' + JSON.stringify(row));
  const pairs = rows.map(r => [r.from, r.to].sort().join('+'));
  assert.ok(pairs.includes(['a1', 'a2'].sort().join('+')), '同一文件夹的材料应该被提为候选');
  assert.ok(!pairs.includes(['x1', 'x2'].sort().join('+')), '毫无共同信号的一对不该被提');
});

test('共同专名能提为候选，理由里写清是哪个词', () => {
  const entities = [
    mk('e1', 'topic', {title: '示例科技 3D 存算一体 调研'}),
    mk('e2', 'artifact', {title: '示例科技 路演纪要'}),
    mk('z1', 'topic', {title: '别的题目'}),
  ];
  const rows = relationCandidates(entities);
  const hit = rows.find(r => [r.from, r.to].sort().join('+') === ['e1', 'e2'].sort().join('+'));
  assert.ok(hit, '共同专名应当成为候选');
  assert.match(hit.reason, /示例科技/, '理由里要写清是哪个词，不能只说"看起来相关"');
});
