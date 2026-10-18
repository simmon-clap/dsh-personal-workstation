/** 建议闭环的 Agent 路径：工具能带依据提建议，也能查到"已被否决的建议"。
 *
 *  背景（宪章第四条）：建议必须闭环 —— 依据要能追、你的回应要被记住、
 *  被否决的不要反复推荐（"不复活"）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter, toolDefinition} from '../src/dsh-adapter.mjs';

const WORKSPACE = {id: 'w-1', title: '飞书工作区', path: '/tmp/ws'};

function setup() {
  const store = new WorkstationStore(':memory:');
  const adapter = new DshAdapter({
    store,
    sessions: {get: () => ({header: {cwd: WORKSPACE.path}})},
    workspaceRegistry: {resolveByPath: async () => WORKSPACE, get: () => WORKSPACE},
    allowedWorkspaces: [WORKSPACE.id],
    approval: {request: async () => 'allowed-once'},
  });
  return {store, call: (action, args = {}) => adapter.run({action, ...args}, {agent: {id: 'session-1'}, callId: 'c1'})};
}

test('工具能带依据、不确定性、参考判断提建议（不需要审批即可生成草稿）', async () => {
  const {store, call} = setup();
  try {
    // 先有一条判断作为依据
    const judgment = await call('draft', {title: '建判断', changes: [{op: 'create', id: 'j-1', kind: 'judgment', data: {
      title: '服务器端短期难以成立', evidence: [{kind: 'message', ref: 'msg-1', quote: '价格敏感'}], validFrom: '2026-10-11', status: 'current',
    }}]});
    await call('commit', {id: judgment.id, revision: 1, key: 'k1'});

    const advice = await call('draft', {
      title: '建议：先索取开发板做零成本验证',
      proposal: {
        evidence: [{kind: 'message', ref: 'msg-9', quote: '先做零成本技术适配验证'}],
        uncertainty: '对方是否愿意提供开发板尚未确认',
        basedOn: ['j-1'],
        decision: 'undecided',
      },
      changes: [{op: 'create', id: 't-1', kind: 'task', data: {title: '索取开发板'}}],
    });
    const saved = store.batch({workspace: WORKSPACE.id, actor: 'a', canWrite: true}, advice.id);
    assert.equal(saved.proposal.basedOn[0], 'j-1');
    assert.equal(saved.proposal.decision, 'undecided');
  } finally { store.close(); }
});

test('proposal_history 让 Agent 在提新建议前避开已被否决的', async () => {
  const {store, call} = setup();
  try {
    const ctx = {workspace: WORKSPACE.id, actor: 'a', canWrite: true};
    // 起草时就带上用户的否决与理由，然后取消这次改动 —— 建议的生命周期走完
    const advice = await call('draft', {
      title: '建议：直接安排与股东见面',
      proposal: {decision: 'rejected', reason: '优先级不对，先看技术再谈股权'},
      changes: [{op: 'create', id: 't-9', kind: 'task', data: {title: '安排股东见面'}}],
    });
    await call('cancel_draft', {id: advice.id, revision: advice.revision});

    const history = await call('proposal_history', {limit: 20});
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].decision, 'rejected');
    assert.equal(history.items[0].reason, '优先级不对，先看技术再谈股权');
    assert.equal(store.batch(ctx, advice.id).status, 'cancelled', '否决后这次改动是被取消的');
  } finally { store.close(); }
});

test('工具 schema 暴露了 proposal 与只读的 proposal_history', () => {
  const {store} = setup();
  try {
    const adapter = new DshAdapter({
      store,
      sessions: {get: () => ({header: {cwd: WORKSPACE.path}})},
      workspaceRegistry: {resolveByPath: async () => WORKSPACE, get: () => WORKSPACE},
      allowedWorkspaces: [WORKSPACE.id],
      approval: {request: async () => 'allowed-once'},
    });
    const schema = JSON.stringify(toolDefinition(adapter));
    assert.ok(schema.includes('proposal_history'), '工具动作里必须有 proposal_history');
    assert.ok(schema.includes('basedOn'), '工具参数里必须有 basedOn（「为什么这么建议」的数据来源）');
  } finally { store.close(); }
});

test('proposal stats report adoption rate and its change without counting silence', () => {
  const { store } = setup();
  const ctx = { workspace: WORKSPACE.id, actor: 'a', canWrite: true };
  try {
    const decide = (id, decision, when) => {
      const draft = store.draft(ctx, {
        title: '建议 ' + id,
        proposal: { decision, reason: decision === 'accepted' ? '' : '理由 ' + id, decidedAt: when },
        changes: [{ op: 'create', id: 't-' + id, kind: 'task', data: { title: '任务 ' + id } }],
      });
      store.cancelDraft?.(ctx, draft.id, draft.revision);
      return draft;
    };
    decide('a', 'accepted', '2026-10-01T00:00:00.000Z');
    decide('b', 'accepted', '2026-10-02T00:00:00.000Z');
    decide('c', 'rejected', '2026-10-03T00:00:00.000Z');
    decide('d', 'rewritten', '2026-10-04T00:00:00.000Z');
    // 没回应的不算进采纳率（沉默 ≠ 采纳）
    store.draft(ctx, { title: '没回应的建议', changes: [{ op: 'create', id: 't-x', kind: 'task', data: { title: 'X' } }] });
    const stats = store.proposalStats(ctx, { limit: 20 });
    assert.equal(stats.current.total, 4);
    assert.equal(stats.current.accepted, 2);
    assert.equal(stats.current.rejected, 1);
    assert.equal(stats.current.rewritten, 1);
    assert.equal(stats.current.rate, 75, '采纳率 = (采纳 + 改写) / 已回应');
    assert.equal(stats.previous.total, 0, '没有更早一段时不编造对比');
    assert.equal(stats.deltaPoints, null);
  } finally { store.close(); }
});
