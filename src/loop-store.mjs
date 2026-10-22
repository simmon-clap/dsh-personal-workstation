import {randomUUID} from 'node:crypto';
import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';

/** 着落本（宪章 v1.4 第二条「件件有着落」· spec/55 P2）。
 *
 *  ## 它解决什么
 *  比"没做完"更糟的是**没人知道它去哪了**：一条待办挂在「等待」上三个月，
 *  谁也说不清是在等谁、等到什么时候。这类东西不会报错、不会提醒，只会慢慢烂掉。
 *  着落本强制每件挂起的事都写下**终态**：
 *
 *    done       —— 做完了
 *    dropped    —— 决定不做了
 *    handed_off —— 转给别人了
 *    waiting    —— 在等谁（必须写清"等谁"+"等到什么时候"）
 *
 *  ## 为什么 waiting 必须带期限
 *  没有期限的"在等"等于永久悬案：它不会到期，因此永远不会被扫出来。
 *  所以 waiting 缺 waiting_for 或 waiting_until 直接拒收 —— 宁可让人当场想清楚，
 *  也不收一条以后没人能判断的账。
 *
 *  ## 与任务自带的 status 的关系
 *  task.status 说的是"做到哪一步"（todo/waiting/in_progress/done/cancelled），
 *  着落本说的是"这件事最后怎么收的"。两者不重复：一个任务可以 status=done，
 *  但它的**结论**（交付给谁、为什么放弃）只有着落本能记。
 */

export const LOOP_STATES = ['done', 'dropped', 'handed_off', 'waiting'];

const blank = value => typeof value !== 'string' || !value.trim();

export class LoopStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS loop(
   workspace TEXT NOT NULL,
   id TEXT NOT NULL,
   subject_kind TEXT NOT NULL,
   subject_id TEXT NOT NULL,
   state TEXT NOT NULL,
   waiting_for TEXT,
   waiting_until TEXT,
   opened_at TEXT NOT NULL,
   closed_at TEXT,
   note TEXT,
   PRIMARY KEY(workspace,id));`);
  // 一件事只留一条**当前**着落：同一事项再写就是更新，不是新增一条并列的说法。
  store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS loop_subject ON loop(workspace,subject_kind,subject_id);');
 }

 /** 写一条着落（已有则更新）。 */
 close(ctx, {subjectKind, subjectId, state, waitingFor = null, waitingUntil = null, note = null, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (blank(subjectKind) || blank(subjectId)) throw new DomainError('INVALID', '着落本：要指明是哪件事');
  if (!LOOP_STATES.includes(state)) throw new DomainError('INVALID', '着落本：终态只能是 完成 / 放弃 / 转出 / 在等谁');
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new DomainError('INVALID', '着落本：时间无效');
  if (state === 'waiting') {
   if (blank(waitingFor)) throw new DomainError('INVALID', '着落本：选了「在等谁」就必须写清在等谁');
   if (blank(waitingUntil) || !Number.isFinite(Date.parse(waitingUntil))) {
    throw new DomainError('INVALID', '着落本：选了「在等谁」就必须写清等到什么时候（没有期限的等待等于永久悬案）');
   }
  } else if (!blank(waitingFor) || !blank(waitingUntil)) {
   throw new DomainError('INVALID', '着落本：不是「在等谁」就别填等谁/等到什么时候');
  }
  const existing = this.forSubject(ctx, {subjectKind, subjectId});
  const body = {
   id: existing?.id ?? randomUUID(), subjectKind: subjectKind.trim(), subjectId: subjectId.trim(), state,
   waitingFor: blank(waitingFor) ? null : waitingFor.trim(),
   waitingUntil: blank(waitingUntil) ? null : waitingUntil,
   openedAt: existing?.openedAt ?? at,
   closedAt: state === 'waiting' ? null : at,      // 在等 ≠ 结案：它还没结束，只是有主了
   note: blank(note) ? null : note.trim(),
  };
  if (existing) {
   s.db.prepare(`UPDATE loop SET state=?,waiting_for=?,waiting_until=?,closed_at=?,note=? WHERE workspace=? AND id=?`)
    .run(body.state, body.waitingFor, body.waitingUntil, body.closedAt, body.note, ROOT_SCOPE, body.id);
  } else {
   s.db.prepare(`INSERT INTO loop(workspace,id,subject_kind,subject_id,state,waiting_for,waiting_until,opened_at,closed_at,note)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(ROOT_SCOPE, body.id, body.subjectKind, body.subjectId, body.state,
    body.waitingFor, body.waitingUntil, body.openedAt, body.closedAt, body.note);
  }
  s.log(ctx, 'loop_closed', {subjectId: body.subjectId, state: body.state});
  return body;
 }

 forSubject(ctx, {subjectKind, subjectId}) {
  this.store.context(ctx);
  const row = this.store.db.prepare('SELECT * FROM loop WHERE workspace=? AND subject_kind=? AND subject_id=?')
   .get(ROOT_SCOPE, subjectKind, subjectId);
  return row ? rowToBody(row) : null;
 }

 list(ctx, {state = null, limit = 100} = {}) {
  this.store.context(ctx);
  const rows = state
   ? this.store.db.prepare('SELECT * FROM loop WHERE workspace=? AND state=? ORDER BY rowid DESC LIMIT ?').all(ROOT_SCOPE, state, limit)
   : this.store.db.prepare('SELECT * FROM loop WHERE workspace=? ORDER BY rowid DESC LIMIT ?').all(ROOT_SCOPE, limit);
  return rows.map(rowToBody);
 }

 /** 扫一遍"悬着的"：等超期的、以及**一直没有着落**的给定事项。
  *  @param subjects 形如 [{kind,id,title,dueDate}] —— 从业务侧传进来要核对的对象；
  *                  没着落且已经过了 dueDate 的会被列出来。 */
 sweep(ctx, {now = new Date(), subjects = [], overdueGraceDays = 3} = {}) {
  this.store.context(ctx);
  const overdue = this.list(ctx, {state: 'waiting'})
   .filter(item => Number.isFinite(Date.parse(item.waitingUntil)) && Date.parse(item.waitingUntil) < now.getTime())
   .map(item => ({...item, reason: '说好等到 ' + item.waitingUntil + '，已经过了'}));

  const graceMs = Math.max(0, overdueGraceDays) * 86400000;
  const unlanded = [];
  for (const subject of subjects) {
   if (!subject?.id) continue;
   const existing = this.forSubject(ctx, {subjectKind: subject.kind, subjectId: subject.id});
   if (existing) continue;                       // 已有着落（含"在等谁"）就不再报
   const due = Date.parse(subject.dueDate ?? '');
   if (!Number.isFinite(due)) continue;
   if (due + graceMs >= now.getTime()) continue; // 还没到该催的时候
   unlanded.push({subjectKind: subject.kind, subjectId: subject.id, title: subject.title ?? subject.id,
    dueDate: subject.dueDate, reason: '过了交付日期 ' + overdueGraceDays + ' 天还没有着落（完成/放弃/转出/在等谁）'});
  }
  return {overdue, unlanded};
 }
}

const rowToBody = row => ({
 id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, state: row.state,
 waitingFor: row.waiting_for, waitingUntil: row.waiting_until,
 openedAt: row.opened_at, closedAt: row.closed_at, note: row.note,
});
