import {randomUUID} from 'node:crypto';
import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';

/** 收件本（宪章 v1.4 第二条「事事有回应」· spec/03 §13 入口矩阵 · spec/55 P1）。
 *
 *  ## 它解决什么
 *  现在一条东西进来（页面上打的、对话里说的、IM 发的、语音转的），可能**没有下文**。
 *  收件本强制每条输入都落一行，且状态只能是三个之一：
 *    captured  —— 记下了（已归到某个对象）
 *    not_mine  —— 判断过，不用你管（必须写理由）
 *    needs_you —— 需要你一句话（必须写理由）
 *  **没有"处理中"的黑洞**：存不下第三种状态，也就不会出现"它大概在处理吧"。
 *
 *  ## 为什么是独立表而不是往 entities 里塞
 *  与 heartbeat_runs / speak_feedback / beat 同类：**运行记录，不是业务对象**。
 *  不进画布、不进收件箱对象列表、不参与实体版本与批次治理（约束二：新增对象类型属范围变更）。
 *
 *  ## 不记正文
 *  只记 `source_ref` 与一句摘要（≤200 字）。正文留在原处 —— 复制一份就会有两个来源，
 *  而且会让导出/备份把外部内容一起带走（宪章 v1.3 第八条）。
 */

export const INTAKE_STATES = ['captured', 'not_mine', 'needs_you'];
export const INTAKE_SOURCES = ['page', 'chat', 'im', 'voice', 'calendar', 'mail', 'file', 'health', 'timer'];

/** 一条输入必须有归属；归不上就写 unassigned，**不猜**（F3）。 */
const isBlank = value => typeof value !== 'string' || !value.trim();

export class IntakeStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS intake(
   workspace TEXT NOT NULL,
   id TEXT NOT NULL,
   at TEXT NOT NULL,
   source TEXT NOT NULL,
   source_ref TEXT,
   summary TEXT NOT NULL,
   state TEXT NOT NULL,
   reason TEXT,
   subject_kind TEXT,
   subject_id TEXT,
   unassigned INTEGER NOT NULL DEFAULT 0,
   closed_at TEXT,
   PRIMARY KEY(workspace,id));`);
 }

 /** 记一条输入。校验全部在写入前完成：宁可不收，也不收一条说不清的。 */
 append(ctx, {source, summary, state = 'captured', reason = null, sourceRef = null,
  subjectKind = null, subjectId = null, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (isBlank(source) || !INTAKE_SOURCES.includes(source.trim())) {
   throw new DomainError('INVALID', '收件本：不认识的来路「' + String(source) + '」');
  }
  if (isBlank(summary)) throw new DomainError('INVALID', '收件本：这条没有内容，不能收');
  if (summary.length > 200) throw new DomainError('INVALID', '收件本：摘要请控制在 200 字内');
  if (!INTAKE_STATES.includes(state)) throw new DomainError('INVALID', '收件本：状态只能是 记下了 / 不用你管 / 需要你一句话');
  // 后两种状态必须写理由 —— 这是「说了不打扰你」的唯一凭据，缺了就成了黑箱。
  if (state !== 'captured' && isBlank(reason)) {
   throw new DomainError('INVALID', '收件本：「' + state + '」必须写清理由');
  }
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new DomainError('INVALID', '收件本：时间无效');
  const hasSubject = !isBlank(subjectId);
  if (state === 'captured' && !hasSubject) {
   // 记下了却没有归属：允许，但必须显式标成"未归属"，让界面能列出来，而不是假装归属完成。
   // 这是 F3「未归属如实显示」在收件本这一层的落点。
  }
  const body = {
   id: randomUUID(), at, source: source.trim(), sourceRef: isBlank(sourceRef) ? null : sourceRef.trim(),
   summary: summary.trim(), state,
   reason: isBlank(reason) ? null : reason.trim(),
   subjectKind: hasSubject && !isBlank(subjectKind) ? subjectKind.trim() : null,
   subjectId: hasSubject ? subjectId.trim() : null,
   // 「未归属」只描述一种情况：**记下了，但不知道归到哪**。
   // 不用你管 / 需要你一句话这两类本来就不属于任何对象，把它们算成"没人接"会让清单永远清不空。
   unassigned: state === 'captured' && !hasSubject,
   closedAt: state === 'captured' && hasSubject ? null : at, // 已归属的还开着；其余当场就有结论
  };
  s.db.prepare(`INSERT INTO intake(workspace,id,at,source,source_ref,summary,state,reason,subject_kind,subject_id,unassigned,closed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(ROOT_SCOPE, body.id, body.at, body.source, body.sourceRef,
   body.summary, body.state, body.reason, body.subjectKind, body.subjectId, body.unassigned ? 1 : 0, body.closedAt);
  s.log(ctx, 'intake_recorded', {id: body.id, source: body.source, state: body.state});
  return body;
 }

 /** 补归属（人后来指了它是哪个项目/任务）。只允许补一次，补完就关单。 */
 assign(ctx, id, {subjectKind, subjectId, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (isBlank(subjectId)) throw new DomainError('INVALID', '收件本：要指定归到哪个对象');
  const row = this.get(ctx, id);
  if (!row) throw new DomainError('NOT_FOUND', '收件本里没有这一条');
  if (!row.unassigned) throw new DomainError('CONFLICT', '这一条已经归属过了');
  s.db.prepare('UPDATE intake SET subject_kind=?, subject_id=?, unassigned=0, closed_at=? WHERE workspace=? AND id=?')
   .run(isBlank(subjectKind) ? null : subjectKind.trim(), subjectId.trim(), at, ROOT_SCOPE, id);
  s.log(ctx, 'intake_assigned', {id, subjectId});
  return this.get(ctx, id);
 }

 /** 回一句话：把「需要你一句话」的单子结掉。
  *  answer 只有两种人话：'知道了'（处理过了）/ '不用管'（判断为不需要你处理）。
  *  结掉之后不再出现在「等你一句话」里 —— 这就是"事事有回应"的收口。 */
 resolve(ctx, id, {answer, note = null, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  const row = this.get(ctx, id);
  if (!row) throw new DomainError('NOT_FOUND', '收件本里没有这一条');
  if (row.state !== 'needs_you') throw new DomainError('CONFLICT', '这一条不在「等你一句话」里，不用再回');
  if (!['知道了', '不用管'].includes(answer)) throw new DomainError('INVALID', '收件本：只能回「知道了」或「不用管」');
  const state = answer === '知道了' ? 'captured' : 'not_mine';
  const reason = answer === '知道了' ? (note?.trim() || '你说处理过了') : (note?.trim() || '你说不用管');
  s.db.prepare('UPDATE intake SET state=?, reason=?, closed_at=? WHERE workspace=? AND id=?')
   .run(state, reason, at, ROOT_SCOPE, id);
  s.log(ctx, 'intake_resolved', {id, answer});
  return this.get(ctx, id);
 }

 get(ctx, id) {
  this.store.context(ctx);
  const row = this.store.db.prepare('SELECT * FROM intake WHERE workspace=? AND id=?').get(ROOT_SCOPE, id);
  return row ? rowToBody(row) : null;
 }

 /** 列表：按状态与来路筛，默认最近 50 条。 */
 list(ctx, {state = null, source = null, unassigned = null, limit = 50} = {}) {
  this.store.context(ctx);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('INVALID', '收件本查询条数无效');
  const where = ['workspace=?'];
  const params = [ROOT_SCOPE];
  if (state) {
   if (!INTAKE_STATES.includes(state)) throw new DomainError('INVALID', '收件本：状态无效');
   where.push('state=?'); params.push(state);
  }
  if (source) { where.push('source=?'); params.push(source); }
  if (unassigned === true) where.push('unassigned=1');
  const rows = this.store.db.prepare(
   `SELECT * FROM intake WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...params, limit);
  return rows.map(rowToBody);
 }

 /** 「没人接」清单：未归属的，以及已经挂着等你一句话超过 N 小时的。 */
 open(ctx, {waitingHours = 24, now = new Date(), limit = 50} = {}) {
  this.store.context(ctx);
  const rows = this.store.db.prepare('SELECT * FROM intake WHERE workspace=? AND (unassigned=1 OR state=\'needs_you\') ORDER BY rowid ASC').all(ROOT_SCOPE);
  const cutoff = now.getTime() - waitingHours * 3600_000;
  return rows.map(rowToBody)
   .filter(item => item.unassigned || item.state === 'needs_you')
   .map(item => ({...item, overdue: Date.parse(item.at) < cutoff}))
   .slice(0, limit);
 }

 /** 给状态面用的四个数：今天收了多少、其中多少还没归属、多少在等你、多少不用你管。 */
 summary(ctx, {now = new Date()} = {}) {
  this.store.context(ctx);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const rows = this.store.db.prepare('SELECT state, unassigned FROM intake WHERE workspace=? AND at>=?').all(ROOT_SCOPE, dayStart);
  return {
   today: rows.length,
   captured: rows.filter(r => r.state === 'captured').length,
   notMine: rows.filter(r => r.state === 'not_mine').length,
   needsYou: rows.filter(r => r.state === 'needs_you').length,
   unassigned: rows.filter(r => r.unassigned === 1).length,
  };
 }
}

const rowToBody = row => ({
 id: row.id, at: row.at, source: row.source, sourceRef: row.source_ref, summary: row.summary,
 state: row.state, reason: row.reason, subjectKind: row.subject_kind, subjectId: row.subject_id,
 unassigned: row.unassigned === 1, closedAt: row.closed_at,
});
