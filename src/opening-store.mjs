import {randomUUID} from 'node:crypto';
import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';

/** 开口记录（spec/55 P3 · 宪章 v1.4 第二条「事事有回应」）。
 *
 *  一次开口 = 早上/晚上那一次"它先开口"。记的不是文案，而是**判断的可回放证据**：
 *  这次用哪个锚点、端出哪几条、哪些被筛掉了、为什么。
 *
 *  ## 为什么必须记"没说什么"
 *  「克制」只有在**能证明它看过**的时候才可信。只记说出来的那几条，
 *  永远无法回答"那件更重要的事它怎么没提"——那是信任崩掉的起点。
 *
 *  ## 一天一个锚点只开口一次
 *  同一锚点重复开口就是催促（03 §6 ④「不重复不升级」）。所以按 (日期, 锚点) 唯一。
 */

export class OpeningStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS opening(
   workspace TEXT NOT NULL,
   id TEXT NOT NULL,
   day TEXT NOT NULL,
   anchor TEXT NOT NULL,
   at TEXT NOT NULL,
   items TEXT NOT NULL,
   skipped TEXT NOT NULL,
   summary TEXT NOT NULL,
   run_id TEXT,
   PRIMARY KEY(workspace,id));`);
  // 同一锚点一天只开一次口；重复写就是催促，不是新信息。
  store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS opening_day_anchor ON opening(workspace,day,anchor);');
 }

 /** 记一次开口。items 是判断层挑出来的（含三问），skipped 是没进去的原因。 */
 record(ctx, {anchor, items = [], skipped = [], summary = '', runId = null, at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (typeof anchor !== 'string' || !anchor.trim()) throw new DomainError('INVALID', '开口记录：要写明这次是早上还是晚上');
  if (!Array.isArray(items) || !Array.isArray(skipped)) throw new DomainError('INVALID', '开口记录：条目格式无效');
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new DomainError('INVALID', '开口记录：时间无效');
  const day = at.slice(0, 10);
  const existing = this.forDay(ctx, {day, anchor});
  if (existing) return existing;   // 幂等：同一个锚点重复触发不改写已有记录
  const body = {id: randomUUID(), day, anchor: anchor.trim(), at,
   items, skipped, summary: String(summary ?? ''), runId};
  s.db.prepare('INSERT INTO opening(workspace,id,day,anchor,at,items,skipped,summary,run_id) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(ROOT_SCOPE, body.id, body.day, body.anchor, body.at, JSON.stringify(items), JSON.stringify(skipped), body.summary, body.runId);
  s.log(ctx, 'opening_recorded', {id: body.id, anchor: body.anchor, count: items.length});
  return body;
 }

 forDay(ctx, {day, anchor}) {
  this.store.context(ctx);
  const row = this.store.db.prepare('SELECT * FROM opening WHERE workspace=? AND day=? AND anchor=?').get(ROOT_SCOPE, day, anchor);
  return row ? rowToBody(row) : null;
 }

 list(ctx, {limit = 20} = {}) {
  this.store.context(ctx);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID', '开口记录查询条数无效');
  return this.store.db.prepare('SELECT * FROM opening WHERE workspace=? ORDER BY rowid DESC LIMIT ?')
   .all(ROOT_SCOPE, limit).map(rowToBody);
 }

 /** 今天这个锚点是不是已经开过口了（定时器每 5 分钟问一次，靠它避免重复）。 */
 openedToday(ctx, {anchor, now = new Date()}) {
  return Boolean(this.forDay(ctx, {day: now.toISOString().slice(0, 10), anchor}));
 }
}

const rowToBody = row => ({
 id: row.id, day: row.day, anchor: row.anchor, at: row.at,
 items: safeParse(row.items), skipped: safeParse(row.skipped), summary: row.summary, runId: row.run_id,
});
const safeParse = text => {
 try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; }
};
