/** 收件箱「点不动」的两类真因（2026-10-16 用户实测）。
 *
 *  现场：用户说"我在工作台无法点击收件箱四条"。挖下去是两个独立缺陷：
 *
 *  ① **恢复（restore）改动被误判成"需补充/冲突"**：restore 本来就不带数据（从库里恢复），
 *     而预览的校验把 `undefined` 当数据去校验 → 报「对象类型或数据无效」→ 整批被判 blocked →
 *     **在「待确认」里根本看不见**。用户看到的是"这一栏没有要你确认的改动"。
 *
 *  ② **冲突提示是空头承诺**：服务端原来写「这条内容在你操作前刚被改过（保存时会用最新内容重试）」，
 *     但真正会重放的只有 `batch.apply`（自己改自己的东西那条路）；
 *     **收件箱点「同意」不会重放** —— 用户点完只看到一句"会重试"，然后什么都没发生。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
import {WorkstationStore} from '../src/store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

test('restore 改动不带数据，也不算"需补充/冲突"（否则用户在待确认里看不见它）', () => {
  const store = new WorkstationStore(':memory:');
  try {
    const seed = store.draft(ctx, {title: '铺底', changes: [{op: 'create', id: 'p1', kind: 'project', data: {title: 'P1'}}]});
    store.commit(ctx, {batchId: seed.id, revision: seed.revision, key: 'seed'});
    const archived = store.draft(ctx, {title: '先归档', changes: [{op: 'archive', id: 'p1', expectedRevision: 1}]});
    store.commit(ctx, {batchId: archived.id, revision: archived.revision, key: 'archive'});

    const restore = store.draft(ctx, {title: '恢复', changes: [{op: 'restore', id: 'p1', expectedRevision: 2}]});
    const preview = store.preview(ctx, restore.id);
    assert.deepEqual(preview.validationErrors ?? [], [], '恢复不该报校验错 —— 它没有数据要校验');
  } finally { store.close(); }
});

test('冲突提示不许承诺"会自动重试"（收件箱这条路上没有重试）', () => {
  const store = readFileSync(join(root, 'src', 'store.mjs'), 'utf8');
  const conflictLine = store.slice(store.indexOf("fail('CONFLICT','这条内容在你操作前刚被改过"), store.indexOf("fail('CONFLICT','这条内容在你操作前刚被改过") + 120);
  assert.doesNotMatch(conflictLine, /会重试|重试的|自动重放/, '收件箱点同意不会重放，写"会重试"就是空头承诺');
  assert.match(conflictLine, /已经过期/, '要说清"这条已经过期"，用户才知道该撤掉它');
});

test('Agent 建了非法改动就就地退回，不留在用户的收件箱里', () => {
  const adapter = readFileSync(join(root, 'src', 'dsh-adapter.mjs'), 'utf8');
  const at = adapter.indexOf("if(args.action==='draft')");
  assert.ok(at > 0, '找不到 Agent 的 draft 分支');
  const block = adapter.slice(at, adapter.indexOf('cancel_draft', at));
  assert.match(block, /preview\(fresh,created\.id\)/, '建完要立刻用同一套校验复核');
  assert.match(block, /cancelDraft\(fresh,created\.id/, '不合法就撤掉 —— 不能把用户改不了的垃圾留给他');
  assert.match(block, /validationErrors/, '判据是"有校验错"');
});
