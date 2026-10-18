/** 建议闭环的数据层（宪章第四条「建议必须闭环」F10–F14 的规则部分）。
 *
 *  方案 A（用户 2026-10-13 拍板）：**不新增对象类型**，建议挂在收件箱的待决定项上，
 *  补四个字段：依据 / 不确定性 / 你的回应 / 你的理由。另加 basedOn（参考了你哪几条判断），
 *  「为什么这么建议」靠它取数 —— 取不到就必须自曝是通用建议。
 *
 *  这组断言守三件事：
 *  ① 改写与否决**必须**留一句理由（否则系统只学会顺从，学不到你的标准）；
 *  ② 回应与被引用都必须真实（basedOn 只能指向存在的判断）；
 *  ③ 改内容不抹掉回应（修订草稿时没带 proposal 就保留原来的）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';

const ctx = {workspace: 'test', actor: 'test', canWrite: true};
const basis = (over = {}) => ({kind: 'message', ref: 'msg-1', quote: '对方说服务器价格敏感', verified: false, ...over});

function makeStore() {
  const store = new WorkstationStore(':memory:');
  // 先落一条判断，作为"为什么这么建议"的依据
  const seed = store.draft(ctx, {
    title: '建判断',
    changes: [{op: 'create', id: 'j-1', kind: 'judgment', data: {
      title: '服务器端短期难以成立', evidence: [basis()], validFrom: '2026-10-11', status: 'current',
    }}],
  });
  store.commit(ctx, {batchId: seed.id, revision: 1, key: 'seed'});
  return store;
}

let seq = 0;
function propose(store, proposal) {
  seq += 1;
  return store.draft(ctx, {
    title: '建议：先索取开发板做零成本验证',
    proposal,
    changes: [{op: 'create', id: 't-advice-' + seq, kind: 'task', data: {title: '索取开发板 ' + seq}}],
  });
}

test('建议带依据与参考判断可以落地，并能读回', () => {
  const store = makeStore();
  try {
    const batch = propose(store, {
      evidence: [basis({quote: '先做零成本技术适配验证'})],
      uncertainty: '对方是否愿意提供开发板尚未确认',
      basedOn: ['j-1'],
      decision: 'undecided',
    });
    store.commit(ctx, {batchId: batch.id, revision: 1, key: 'advice-1'});
    const saved = store.batch(ctx, batch.id);
    assert.equal(saved.proposal.decision, 'undecided');
    assert.equal(saved.proposal.basedOn[0], 'j-1');
    assert.equal(saved.proposal.evidence.length, 1);
    assert.equal(saved.proposal.uncertainty, '对方是否愿意提供开发板尚未确认');
  } finally { store.close(); }
});

test('否决必须留一句理由；采纳可以免理由', () => {
  const store = makeStore();
  try {
    assert.throws(() => propose(store, {decision: 'rejected'}), {code: 'INVALID'});
    assert.throws(() => propose(store, {decision: 'rewritten'}), {code: 'INVALID'});
    const accepted = propose(store, {decision: 'accepted'});
    assert.equal(store.batch(ctx, accepted.id).proposal.decision, 'accepted');
    assert.ok(store.batch(ctx, accepted.id).proposal.decidedAt, '回应要带时间');
  } finally { store.close(); }
});

test('理由与不确定性都有长度上限，未知字段被拒', () => {
  const store = makeStore();
  try {
    assert.throws(() => propose(store, {decision: 'rejected', reason: '长'.repeat(301)}), {code: 'INVALID'});
    assert.throws(() => propose(store, {uncertainty: '长'.repeat(301)}), {code: 'INVALID'});
    assert.throws(() => propose(store, {confidence: 0.9}), {code: 'INVALID'});
    assert.throws(() => propose(store, {evidence: [{kind: 'guess', ref: 'x', quote: 'y'}]}), {code: 'INVALID'});
    assert.throws(() => propose(store, {evidence: [{kind: 'note', ref: '  ', quote: 'y'}]}), {code: 'INVALID'});
  } finally { store.close(); }
});

test('basedOn 只能指向真实存在的判断', () => {
  const store = makeStore();
  try {
    const good = propose(store, {basedOn: ['j-1']});
    store.commit(ctx, {batchId: good.id, revision: 1, key: 'ok'});

    const bad = propose(store, {basedOn: ['not-a-judgment']});
    assert.throws(() => store.commit(ctx, {batchId: bad.id, revision: 1, key: 'bad'}), {code: 'REFERENCE'});

    // 指向非判断对象也要被拦
    const project = store.draft(ctx, {title: '项目', changes: [{op: 'create', id: 'p-1', kind: 'project', data: {title: '某项目'}}]});
    store.commit(ctx, {batchId: project.id, revision: 1, key: 'p'});
    const wrongKind = propose(store, {basedOn: ['p-1']});
    assert.throws(() => store.commit(ctx, {batchId: wrongKind.id, revision: 1, key: 'wrong'}), {code: 'REFERENCE'});
  } finally { store.close(); }
});

test('修订草稿时没带 proposal，不会把回应与理由抹掉', () => {
  const store = makeStore();
  try {
    const batch = propose(store, {decision: 'rejected', reason: '优先级不对，先看技术'});
    // 只改标题（不带 proposal）
    const revised = store.draft(ctx, {title: '换个标题', changes: store.batch(ctx, batch.id).changes}, batch.id, 1);
    const saved = store.batch(ctx, revised.id);
    assert.equal(saved.proposal.decision, 'rejected');
    assert.equal(saved.proposal.reason, '优先级不对，先看技术');
  } finally { store.close(); }
});

test('proposalHistory 只返回已回应的建议，供统计与「被否决的不复活」使用', () => {
  const store = makeStore();
  try {
    const pending = propose(store, {decision: 'undecided'});
    const rejected = propose(store, {decision: 'rejected', reason: '成本太高'});
    const accepted = propose(store, {decision: 'accepted'});
    store.commit(ctx, {batchId: rejected.id, revision: 1, key: 'r'});
    store.commit(ctx, {batchId: accepted.id, revision: 1, key: 'a'});
    void pending;

    const history = store.proposalHistory(ctx, {limit: 20});
    assert.equal(history.length, 2, '待决定的建议不应出现在已回应历史里');
    const decisions = history.map(item => item.decision).sort();
    assert.deepEqual(decisions, ['accepted', 'rejected']);
    const rejectedItem = history.find(item => item.decision === 'rejected');
    assert.equal(rejectedItem.reason, '成本太高');
  } finally { store.close(); }
});
