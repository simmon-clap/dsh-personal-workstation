/** 判断对象（宪章第三条「判断是一等公民」，字段契约见 spec/03 §10）。
 *
 *  这些断言守的是三件事：
 *  ① 判断必须带依据，且依据要能指回出处（不能只有一句结论）；
 *  ② 判断必须说明「什么时候成立」与当前状态；
 *  ③ 被推翻时必须留下理由与时间（不抹掉"当时为什么这么想"）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';

const ctx = {workspace: 'test', actor: 'test', canWrite: true};

function expectRejected(data, label) {
  const store = new WorkstationStore(':memory:');
  try {
    const batch = store.draft(ctx, {title: '判断', changes: [{op: 'create', kind: 'judgment', data}]});
    assert.throws(() => store.commit(ctx, {batchId: batch.id, revision: 1, key: batch.id}), {code: 'INVALID'}, label);
    assert.equal(store.list(ctx).length, 0, `${label}：被拒后不应留下记录`);
  } finally {
    store.close();
  }
}

function accept(data) {
  const store = new WorkstationStore(':memory:');
  try {
    const batch = store.draft(ctx, {title: '判断', changes: [{op: 'create', kind: 'judgment', data}]});
    const receipt = store.commit(ctx, {batchId: batch.id, revision: 1, key: batch.id});
    assert.equal(receipt.status ?? 'committed', 'committed');
    return store.list(ctx, {kind: 'judgment'})[0];
  } finally {
    store.close();
  }
}

const evidence = (over = {}) => ({kind: 'message', ref: 'msg-1', quote: '对方自述明年三月投片', verified: false, ...over});

test('合法判断可以写入，并保留依据、什么时候成立与状态', () => {
  const saved = accept({
    title: '服务器端短期难以成立：带宽与成本不匹配现有客户的价格预期',
    evidence: [evidence(), {kind: 'note', ref: 'user-said-1', quote: '价格敏感是硬约束'}],
    uncertainty: '性能与成本为对方自述，未经第三方验证',
    validFrom: '2026-10-11',
    reviewBy: '2026-11-11',
    status: 'checking',
  });
  assert.equal(saved.kind, 'judgment');
  assert.equal(saved.data.evidence.length, 2);
  assert.equal(saved.data.status, 'checking');
  assert.equal(saved.data.validFrom, '2026-10-11');
  assert.equal(saved.data.evidence[0].verified, false);
});

test('判断可以归到真实存在的项目；指向不存在的项目会被引用校验挡住', () => {
  const store = new WorkstationStore(':memory:');
  try {
    // 先建项目，再把判断挂上去
    const project = store.draft(ctx, {title: '建项目', changes: [{op: 'create', kind: 'project', data: {title: '示例科技'}}]});
    store.commit(ctx, {batchId: project.id, revision: 1, key: project.id});
    const projectId = store.list(ctx, {kind: 'project'})[0].id;

    const ok = store.draft(ctx, {
      title: '建判断',
      changes: [{op: 'create', kind: 'judgment', data: {
        title: '服务器端短期难以成立', evidence: [evidence()], validFrom: '2026-10-11', status: 'current', projectId,
      }}],
    });
    store.commit(ctx, {batchId: ok.id, revision: 1, key: ok.id});
    assert.equal(store.list(ctx, {kind: 'judgment'})[0].data.projectId, projectId);

    const bad = store.draft(ctx, {
      title: '挂到不存在的项目',
      changes: [{op: 'create', kind: 'judgment', data: {
        title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'current', projectId: 'proj-不存在',
      }}],
    });
    assert.throws(() => store.commit(ctx, {batchId: bad.id, revision: 1, key: bad.id}), {code: 'REFERENCE'});
    assert.equal(store.list(ctx, {kind: 'judgment'}).length, 1, '被拒的判断不应写进去');
  } finally {
    store.close();
  }
});

test('没有依据的判断写不进去（判断不能只有一句结论）', () => {
  expectRejected({title: '没有依据的判断', evidence: [], validFrom: '2026-10-11', status: 'current'}, '空依据');
  expectRejected({title: '缺依据字段', validFrom: '2026-10-11', status: 'current'}, '无 evidence 字段');
});

test('依据必须能指回出处，也要有出处原文', () => {
  expectRejected({title: 'x', evidence: [evidence({ref: '  '})], validFrom: '2026-10-11', status: 'current'}, '空洞的出处');
  expectRejected({title: 'x', evidence: [evidence({quote: ''})], validFrom: '2026-10-11', status: 'current'}, '空出处原文');
  expectRejected({title: 'x', evidence: [evidence({kind: 'guess'})], validFrom: '2026-10-11', status: 'current'}, '未知来源类型');
  expectRejected({title: 'x', evidence: [{...evidence(), extra: 1}], validFrom: '2026-10-11', status: 'current'}, '依据含未知项');
});

test('「什么时候成立」与状态必须合法', () => {
  expectRejected({title: 'x', evidence: [evidence()], status: 'current'}, '缺什么时候成立');
  expectRejected({title: 'x', evidence: [evidence()], validFrom: '2026/10/11', status: 'current'}, '日期格式错误');
  expectRejected({title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'maybe'}, '未知状态');
});

test('被推翻必须留下理由与时间；没被推翻不能带推翻依据', () => {
  expectRejected({title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'overturned'}, '缺推翻依据');
  expectRejected({
    title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'overturned',
    overturnedBy: {reason: '', at: '2026-10-12'},
  }, '推翻理由为空');
  expectRejected({
    title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'overturned',
    overturnedBy: {reason: '新证据表明成本已下降'},
  }, '缺推翻时间');
  expectRejected({
    title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'current',
    overturnedBy: {reason: '不该有', at: '2026-10-12'},
  }, '未推翻却带推翻依据');
});

test('推翻留痕后旧判断仍然读得到（不抹掉当时为什么这么想）', () => {
  const saved = accept({
    title: '服务器端短期难以成立',
    evidence: [evidence()],
    validFrom: '2026-10-11',
    status: 'overturned',
    overturnedBy: {ref: 'judgment-2', reason: '新证据表明成本结构已变', at: '2026-12-01'},
  });
  assert.equal(saved.data.status, 'overturned');
  assert.equal(saved.data.overturnedBy.reason, '新证据表明成本结构已变');
  assert.equal(saved.data.evidence.length, 1, '推翻不应删除原依据');
});

test('不确定性说明与未知字段都被挡住', () => {
  expectRejected({title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'current', uncertainty: 'x'.repeat(301)}, '不确定性过长');
  expectRejected({title: 'x', evidence: [evidence()], validFrom: '2026-10-11', status: 'current', verdict: '好'}, '未知字段');
});
