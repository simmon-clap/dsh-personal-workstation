/** 建议闭环的两个真断链（宪章第四条，2026-10-16 实测复现后修）。
 *
 *  ① F12「为什么这么建议」在真实链路上**永远自曝通用建议**：
 *     生产规则把 basedOn 放在对象顶层、内容是交付项标题；`writeDraft` 只解构
 *     `{title,changes,source,proposal}` → 落库恒为 null。界面读的是 `proposal.basedOn`。
 *  ② F14「被否决的不复活」在真实链路上**不成立**：
 *     重复检查只查 `status:'draft'`，而被否决的批次状态是 `cancelled` →
 *     同一句话第二天照样重提（而界面上写着"不再推荐"）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {buildAdvice} from '../src/advice.mjs';

const ctx = {workspace: 'w', actor: 'operator:test', canWrite: true};

/** 一个"交付项都做完了、该推进"的项目 —— 这是建议规则唯一起作用的场景。 */
function projectWithAllDeliverablesDone(store, {id = 'p-1', stage = '接触'} = {}) {
  store.draft(ctx, {
    title: '建项目',
    changes: [{
      op: 'create', id, kind: 'project',
      data: {title: '测试项目', stage, deliverables: [{id: 'd-1', title: '调研', done: true}, {id: 'd-2', title: '对齐', done: true}]},
    }],
  }, 'b-' + id);
  const draft = store.batch(ctx, 'b-' + id);
  store.commit(ctx, {batchId: draft.id, revision: draft.revision, key: 'p-' + id});
  return store.get(ctx, id);
}

function judgmentsFor(store, projectId, {status = 'checking', id = 'j-1'} = {}) {
  store.draft(ctx, {
    title: '建判断',
    changes: [{
      op: 'create', id, kind: 'judgment',
      data: {
        title: '这条判断还没有核对', projectId, status, validFrom: '2026-10-01',
        evidence: [{kind: 'message', ref: 'msg-1', quote: '对方口头说的', verified: false}],
      },
    }],
  }, 'b-' + id);
  const draft = store.batch(ctx, 'b-' + id);
  store.commit(ctx, {batchId: draft.id, revision: draft.revision, key: 'j-' + id});
  return store.get(ctx, id);
}

test('F12：读了判断就要把 basedOn 落到 proposal 里（界面才追问得出来）', () => {
  const store = new WorkstationStore(':memory:');
  try {
    projectWithAllDeliverablesDone(store);
    judgmentsFor(store, 'p-1');
    buildAdvice({store, ctx});
    const batches = store.inbox(ctx).filter(b => b.proposal);
    assert.equal(batches.length, 1, '应该提出一条建议');
    assert.deepEqual(batches[0].proposal.basedOn, ['j-1'],
      'basedOn 必须落在 proposal 里并指向真实判断 —— 放在顶层会被 writeDraft 静默丢弃（这就是 F12 空转的原因）');
  } finally { store.close(); }
});

test('F12：没有判断可依据时**不写** basedOn（界面据此自曝通用建议，不装样子）', () => {
  const store = new WorkstationStore(':memory:');
  try {
    projectWithAllDeliverablesDone(store);
    buildAdvice({store, ctx});
    const batch = store.inbox(ctx).filter(b => b.proposal)[0];
    assert.equal(batch.proposal.basedOn, undefined,
      '没有依据就不要给空数组 —— 空数组会让界面以为"有依据但没列出来"');
    assert.equal(batch.proposal.evidence[0].verified, false,
      '完成状态来自工作台自己的记录，没有第三方核过 —— 标 true 是自吹（宪章六·诚实）');
  } finally { store.close(); }
});

test('F14：被否决的建议不再复活（项目没变 = 没有新证据）', () => {
  const store = new WorkstationStore(':memory:');
  try {
    projectWithAllDeliverablesDone(store);
    buildAdvice({store, ctx});
    const first = store.inbox(ctx).filter(b => b.proposal)[0];
    // 你否决它
    store.cancelDraft(ctx, first.id, first.revision);
    // 再跑一次：不许再提
    buildAdvice({store, ctx});
    const again = store.inbox(ctx).filter(b => b.proposal && b.status === 'draft');
    assert.equal(again.length, 0, '被否决过的建议又提了一次 —— 界面却写着"不再推荐"（假承诺）');
  } finally { store.close(); }
});

test('F14：项目真的变了（有新证据）→ 允许重新提一次', () => {
  const store = new WorkstationStore(':memory:');
  try {
    const project = projectWithAllDeliverablesDone(store);
    buildAdvice({store, ctx});
    const first = store.inbox(ctx).filter(b => b.proposal)[0];
    store.cancelDraft(ctx, first.id, first.revision);
    // 项目被改过（版本前进）= 有新证据
    store.draft(ctx, {title: '改项目', changes: [{op: 'update', id: project.id, expectedRevision: project.revision, data: {...project.data, goal: '新目标'}}]}, 'b-change');
    const change = store.batch(ctx, 'b-change');
    store.commit(ctx, {batchId: change.id, revision: change.revision, key: 'change-1'});
    buildAdvice({store, ctx});
    const again = store.inbox(ctx).filter(b => b.proposal && b.status === 'draft');
    assert.equal(again.length, 1, '项目变了之后应该允许重提（否则被否决一次就永远推不动）');
  } finally { store.close(); }
});
