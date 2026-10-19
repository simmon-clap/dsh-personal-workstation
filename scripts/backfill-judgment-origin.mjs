#!/usr/bin/env node
/** 一次性迁移（W3-D / 决策门 D4）：给缺 origin 的判断补来源。
 *
 *  规则（用户 2026-10-18 拍板）：**能查到真实线索就写，查不到不猜**。
 *  线索只来自本库的真实批次：
 *    · 创建批次 source.kind==='advice'（Agent 从会议纪要整理的建议）→ AI 起草
 *    · 创建批次有 source.sessionId（Agent 通道起草）→ AI 起草
 *    · 创建批次 source.operator（你在工作台里录入）→ 你说的
 *    · 找不到创建批次 → 不动它（界面上显示「来源未记录」）
 *
 *  默认 dry-run 只打印；加 --write 会生成**一条待你同意的改动**（不直接写业务数据）。
 *  用法：
 *    node scripts/backfill-judgment-origin.mjs <db> --workspace <id> [--write]
 */
import {WorkstationStore} from '../src/store.mjs';

const args = process.argv.slice(2);
const db = args[0];
const wsIndex = args.indexOf('--workspace');
const workspace = wsIndex >= 0 ? args[wsIndex + 1] : null;
const write = args.includes('--write');
if (!db || !workspace) {
  console.error('用法：node scripts/backfill-judgment-origin.mjs <db> --workspace <id> [--write]');
  process.exit(2);
}

const store = new WorkstationStore(db);
const ctx = {workspace, actor: 'origin-backfill', canWrite: true};
try {
  const originOf = new Map();
  const rows = store.db.prepare('SELECT id,body FROM batches WHERE workspace=?').all(store.batchScopes()[0]);
  for (const row of rows) {
    let body;
    try { body = JSON.parse(row.body); } catch { continue; }
    const source = body?.source ?? {};
    const value = source.kind === 'advice' || source.sessionId ? 'ai' : source.operator ? 'user' : null;
    if (!value) continue;
    for (const change of body?.changes ?? []) {
      if (change?.kind !== 'judgment' || !change.id) continue;
      // 只认"创建"批次作为起草来源：后续编辑不代表谁起草的。
      if (change.op !== 'create' && originOf.has(change.id)) continue;
      if (!originOf.has(change.id) || change.op === 'create') originOf.set(change.id, value);
    }
  }

  const judgments = store.list(ctx, {kind: 'judgment', query: '', includeArchived: false, limit: 1000});
  const missing = judgments.filter(item => item.data?.origin === undefined);
  const resolvable = missing.filter(item => originOf.has(item.id));
  const unknown = missing.filter(item => !originOf.has(item.id));
  console.log(JSON.stringify({
    workspace,
    judgments: judgments.length,
    alreadyHaveOrigin: judgments.length - missing.length,
    resolvable: resolvable.map(item => ({id: item.id, title: item.data?.title, origin: originOf.get(item.id)})),
    stillUnknown: unknown.map(item => ({id: item.id, title: item.data?.title})),
  }, null, 2));

  if (!write) {
    console.log('dry-run：没有写任何东西。确认后加 --write 生成一条待同意的改动。');
  } else if (!resolvable.length) {
    console.log('没有可回填的判断；未创建改动。');
  } else {
    const changes = resolvable.map(item => ({
      op: 'update',
      id: item.id,
      expectedRevision: item.revision,
      data: {...item.data, origin: originOf.get(item.id)},
      sources: {origin: '由创建这批判断时的来源推导：' + (originOf.get(item.id) === 'ai' ? 'Agent 从会议材料起草' : '你在工作台录入')},
    }));
    const draft = store.draft(ctx, {
      title: '补齐 ' + changes.length + ' 条判断的来源（能查到的标 AI 起草 / 你说的）',
      source: {kind: 'advice', rule: 'origin-backfill'},
      changes,
    });
    console.log('已生成待同意改动：' + draft.id + '（在收件箱里点同意后才写进工作台）');
  }
} finally {
  store.close();
}
