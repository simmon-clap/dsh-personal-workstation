import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {WorkstationStore} from '../src/store.mjs';

test('origin backfill only writes real derivable sources and leaves unknown ones alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'origin-backfill-'));
  const db = join(dir, 'workstation.sqlite');
  const store = new WorkstationStore(db);
  const ctx = { workspace: 'ws', actor: 'agent', canWrite: true };
  try {
    const advice = store.draft(ctx, { title: '判断待确认：AI 从纪要整理', source: { kind: 'advice', rule: 'judgment-from-minutes' }, changes: [{ op: 'create', id: 'j-ai', kind: 'judgment', data: { title: 'AI 起草的判断', status: 'current', validFrom: '2026-09-01', evidence: [{ kind: 'file', ref: '纪要#1', quote: '原文' }] } }] });
    store.commit(ctx, { batchId: advice.id, revision: 1, key: 'advice' });
    const manual = store.draft(ctx, { title: '你说的判断', source: { operator: 'opera' }, changes: [{ op: 'create', id: 'j-user', kind: 'judgment', data: { title: '你口述的判断', status: 'current', validFrom: '2026-09-01', evidence: [{ kind: 'note', ref: '你说', quote: '口述' }] } }] });
    store.commit(ctx, { batchId: manual.id, revision: 1, key: 'manual' });
    // 没有创建批次可查的判断：不得猜
    const orphan = store.draft(ctx, { title: '孤立判断', changes: [{ op: 'create', id: 'j-orphan', kind: 'judgment', data: { title: '来源不明的判断', status: 'checking', validFrom: '2026-09-01', evidence: [{ kind: 'note', ref: '无', quote: '无' }] } }] });
    store.commit(ctx, { batchId: orphan.id, revision: 1, key: 'orphan' });
  } finally { store.close(); }

  const output = execFileSync(process.execPath, ['scripts/backfill-judgment-origin.mjs', db, '--workspace', 'ws', '--write'], { encoding: 'utf8' });
  const batchId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(output)?.[1];
  assert.ok(batchId, '必须生成一条待同意的改动：' + output);
  assert.match(output, /j-orphan/);
  assert.match(output, /stillUnknown/);
  const store2 = new WorkstationStore(db);
  const ctx2 = { workspace: 'ws', actor: 'user', canWrite: true };
  try {
    const batch = store2.batch(ctx2, batchId);
    assert.equal(batch.changes.length, 2, '只回填能查到来源的两条');
    store2.commit(ctx2, { batchId, revision: 1, key: 'approve-origin' });
    assert.equal(store2.get(ctx2, 'j-ai').data.origin, 'ai');
    assert.equal(store2.get(ctx2, 'j-user').data.origin, 'user');
    assert.equal(store2.get(ctx2, 'j-orphan').data.origin, undefined, '查不到来源就不许猜');
  } finally { store2.close(); }
});
