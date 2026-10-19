/** 同步判定逻辑的回归测试（宪章 v1.2 第七条多端的三个硬要求）。
 *
 *  这三个 bug 都属于"数据丢失"级，而且是**实测复现过**的：
 *    ① 删除会复活（没有墓碑：删掉的东西被当成"对端新增"又拉回来，且本地删除永远传不出去）
 *    ② 覆盖只写单侧（作为事实源的本机查不到自己覆盖过谁）
 *    ③ 状态与留痕对象（心跳留痕、出声反馈）压根不在同步范围
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSync, planLogSync, newer} from '../sync-plan.mjs';

const W = 'root';
const ent = (id, revision, extra = {}) => ({workspace: W, id, kind: extra.kind ?? 'project', revision, data: JSON.stringify({title: id}), archived: 0, author: 't', at: extra.at ?? '2026-10-16T00:00:00.000Z'});
const tomb = (id, revision, extra = {}) => ({workspace: W, id, kind: extra.kind ?? 'project', revision, at: extra.at ?? '2026-10-16T01:00:00.000Z'});

test('① 本地删掉的对象不会被当成"对端新增"拉回来（删除不复活）', () => {
  const plan = planSync({
    local: [ent('p-keep', 2)],
    remote: [ent('p-keep', 2), ent('p-deleted', 5)],
    localTombstones: [tomb('p-deleted', 6)],
  });
  assert.deepEqual(plan.upsertsLocal.map(r => r.id), [], '删掉的东西又被拉回来了 —— 这就是"删除复活"');
  assert.deepEqual(plan.deletesRemote.map(r => r.id), ['p-deleted'], '本地删除必须推到对端');
  assert.deepEqual(plan.tombstonesRemote.map(r => r.id), ['p-deleted'], '墓碑要跟着过去，否则下次同步还会复活');
});

test('①b 删除之后对端又改过它 → 按新证据保留，并撤掉墓碑', () => {
  const plan = planSync({
    local: [],
    remote: [ent('p-revived', 9)],
    localTombstones: [tomb('p-revived', 6)],
  });
  assert.deepEqual(plan.upsertsLocal.map(r => r.id), ['p-revived'], '对端在删除之后改过它，应当保留');
  assert.deepEqual(plan.tombstonesDrop.map(r => r.id), ['p-revived'], '墓碑必须撤掉，否则以后还会误删');
  assert.equal(plan.resurrected.length, 1);
});

test('①c 对端删掉的对象同样不复活（对称）', () => {
  const plan = planSync({
    local: [ent('p-gone', 3)],
    remote: [],
    remoteTombstones: [tomb('p-gone', 4)],
  });
  assert.deepEqual(plan.deletesLocal.map(r => r.id), ['p-gone']);
  assert.deepEqual(plan.tombstonesLocal.map(r => r.id), ['p-gone']);
});

test('② 覆盖必须**两端**都留痕（不是只写被覆盖的那一侧）', () => {
  const plan = planSync({
    local: [ent('p-1', 7, {at: '2026-10-16T05:00:00.000Z'})],
    remote: [ent('p-1', 3, {at: '2026-10-16T01:00:00.000Z'})],
  });
  assert.equal(plan.overrides.length, 1, '一次覆盖要有一条留痕记录');
  const o = plan.overrides[0];
  assert.equal(o.winner, 'local');
  assert.equal(o.loserRevision, 3, '要写清被覆盖的是哪个版本');
  assert.equal(o.winnerRevision, 7);
  assert.ok(o.reason, '留痕必须带理由');
});

test('③ 常规合并：各自新增互相补、相同不动', () => {
  const plan = planSync({
    local: [ent('a', 1), ent('same', 2)],
    remote: [ent('b', 1), ent('same', 2)],
  });
  assert.deepEqual(plan.upsertsRemote.map(r => r.id), ['a']);
  assert.deepEqual(plan.upsertsLocal.map(r => r.id), ['b']);
  assert.deepEqual(plan.overrides, [], '两边一致时不该产生覆盖');
});

test('③b 状态与留痕对象（心跳留痕/出声反馈）按并集补齐', () => {
  const local = [{workspace: W, id: 'h-1'}, {workspace: W, id: 'h-2'}];
  const remote = [{workspace: W, id: 'h-2'}, {workspace: W, id: 'h-3'}];
  const {toLocal, toRemote} = planLogSync(local, remote);
  assert.deepEqual(toLocal.map(r => r.id), ['h-3'], '对端独有的留痕要拉过来');
  assert.deepEqual(toRemote.map(r => r.id), ['h-1'], '本地独有的留痕要推过去');
});

test('新旧判据：revision 优先，相同才比时间', () => {
  assert.ok(newer(ent('x', 3), ent('x', 2)) > 0);
  assert.ok(newer(ent('x', 2, {at: '2026-10-16T02:00:00.000Z'}), ent('x', 2, {at: '2026-10-16T01:00:00.000Z'})) > 0);
  assert.equal(newer(ent('x', 2), ent('x', 2)), 0);
});
