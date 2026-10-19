/** 自己的操作「直接生效」时，不许在收件箱里留僵尸草稿（2026-10-16 实测缺陷）。
 *
 *  现场：某条判断的「谁能看」被连点三次，真实库里留下 **3 条一模一样的待决定条目**
 *  （都写着 expectedRevision 1，而那条判断已经是 revision 5）—— 点「同意」必然冲突。
 *  而真相是：这三次改动**早就直接生效了**（判断上 share 已经是 team）。
 *
 *  根因：`batch.apply` 走 draft → commit；一旦 commit 报版本冲突，它会**另建一份草稿**用最新版本重放并提交，
 *  但**原来那份冲突草稿留在原处**。于是每冲突一次，收件箱就多一条"已经做完的事"。
 *  这与用户 2026-10-12 拍板的契约直接冲突：「自己的操作直接生效（不进收件箱），只有 AI 提议才进收件箱」。
 *
 *  判据（对着源码与真实行为两处都查）：
 *  ① 冲突重放的分支里必须先撤掉冲突草稿，再提交重放草稿；
 *  ② 撤草稿只能发生在**重放已经成功之后**（不能在还没救回来时就把用户唯一的记录删了）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'prototype', 'batch.mjs'), 'utf8');

test('冲突重放：先撤掉冲突草稿，再提交重放草稿', () => {
  const conflictAt = source.indexOf("error?.code==='CONFLICT'");
  assert.ok(conflictAt > 0, '找不到冲突分支');
  const cancelAt = source.indexOf('cancel_draft', conflictAt);
  assert.ok(cancelAt > conflictAt, '冲突分支里必须撤掉那份冲突草稿（否则它会永远留在收件箱）');

  const freshCommitAt = source.indexOf('send(\'commit\',{id:fresh.id', conflictAt);
  assert.ok(freshCommitAt > 0, '找不到重放草稿的提交');
  assert.ok(cancelAt > freshCommitAt, '必须先确认重放提交成功，再撤冲突草稿 —— 反过来会在没救回来时删掉用户唯一的记录');
});

test('撤草稿失败不能让整次保存失败（catch 掉，保持"已保存"的语义）', () => {
  // 注意：batch.mjs 里还有另一处 cancel_draft（"不同意/取消"那条路径），
  // 这里必须取**冲突分支之后**的那一处，否则测的是别人。
  const cancelAt = source.indexOf('cancel_draft', source.indexOf("error?.code==='CONFLICT'"));
  const line = source.slice(cancelAt, source.indexOf('\n', cancelAt));
  assert.match(line, /catch\(\(\)=>\{\}\)|\.catch\(/, '撤草稿要自带 catch：撤不掉是收件箱脏一点，不该让用户以为保存失败');
});

test('断网/超时的失败路径仍然保留草稿与重试（不误伤）', () => {
  const retryAt = source.indexOf('showRetry(');
  assert.ok(retryAt > 0, '失败路径必须留着');
  assert.match(source.slice(retryAt, retryAt + 200), /id:draft\.id,revision:draft\.revision/, '重试要用同一把幂等键，重试不会写两遍');
});
