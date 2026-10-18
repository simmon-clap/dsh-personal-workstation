import {randomUUID} from 'node:crypto';
import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';
import {speakState} from './speak.mjs';

/** 出声反馈表（F23 双向计量）。
 *
 *  为什么另开一张表而不是塞进 heartbeat_runs：反馈是**你的回应**，记录是**它的动作**，
 *  两者生命周期不同（一条记录可能收到多个回应，也可能永远没有回应）。混在一起会让
 *  "额度"和"它做了什么"互相污染。同样**不是新对象类型**（与 executions / heartbeat_runs 同类）。
 *
 *  允许的回应（03 §11 的原文口径，界面就显示这几个词）：
 *   followed 照着做了(+8) · noted 知道了(+2) · unnecessary 没必要/别再提醒(−10) · ignored 忽略(−3)
 *   missed 该说没说（不改额度，把**该类条件**的门槛下调一档）
 */
const KINDS = ['followed', 'noted', 'unnecessary', 'ignored', 'missed'];

export class SpeakStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS speak_feedback(workspace TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id));`);
 }
 record(ctx, {kind, subjectId = null, condition = null, rule = null, note = null, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (!KINDS.includes(kind)) throw new DomainError('INVALID', '不认识的回应：' + String(kind));
  if (kind === 'missed' && !condition && !rule) throw new DomainError('INVALID', '「该说没说」要指明是哪一类事');
  if (subjectId !== null && (typeof subjectId !== 'string' || !subjectId.trim() || subjectId.length > 200)) throw new DomainError('INVALID', '对象标识无效');
  if (note !== null && (typeof note !== 'string' || note.length > 500)) throw new DomainError('INVALID', '备注无效');
  const body = {id: randomUUID(), revision: 1, at, kind, subjectId, condition: condition ?? rule ?? null, rule: rule ?? condition ?? null, note};
  s.db.prepare('INSERT INTO speak_feedback VALUES(?,?,?,?,?)').run(ROOT_SCOPE, body.id, body.at, body.kind, JSON.stringify(body));
  s.log(ctx, 'speak_feedback', {kind, subjectId, condition: body.condition});
  return body;
 }
 list(ctx, {limit = 50, offset = 0} = {}) {
  this.store.context(ctx);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError('INVALID', '回应查询参数无效');
  const rows = this.store.db.prepare('SELECT body FROM speak_feedback WHERE workspace=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(ROOT_SCOPE, limit + 1, offset);
  return {items: rows.slice(0, limit).map(row => JSON.parse(row.body)), nextOffset: rows.length > limit ? offset + limit : null};
 }
 /** 全部回应（额度要从**全部**反馈算，不能只看最近几条）。 */
 all(ctx) {
  this.store.context(ctx);
  return this.store.db.prepare('SELECT body FROM speak_feedback WHERE workspace=? ORDER BY rowid ASC').all(ROOT_SCOPE).map(row => JSON.parse(row.body));
 }
 /** 额度 / 阶段 / 本周上限 / 免打扰 / 双向计量，一次给界面与工具。 */
 state(ctx, options = {}) {
  this.store.context(ctx);
  return speakState(this.all(ctx), options);
 }
}
export {KINDS};
