import {randomUUID} from 'node:crypto';
import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';

/** 主动做事的记录表（F24）。
 *
 *  为什么是独立表而不是新对象类型：它是**系统的运行记录**，和 executions 同一类 ——
 *  不进画布、不进收件箱的对象列表、不参与实体版本与批次治理。新增业务对象类型属于范围变更
 *  （约束二），而这里不需要它。
 *
 *  留痕必须能回答两件事（03 §6 ⑦）：**这次醒来做了什么**、**为什么没打扰你**。
 *  最后成功时间与连续失败次数都从这张表**算出来**，不另存一份状态 —— 免得出现"状态说成功、
 *  记录里全是失败"这种自欺。
 */
const OUTCOMES = ['ok', 'failed'];
/** 连续失败告警阈值：连续 2 次失败即告警（唯一允许的打扰例外，03 §6 ⑦）。 */
export const FAILURE_ALERT_THRESHOLD = 2;

export class HeartbeatStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS heartbeat_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,startedAt TEXT NOT NULL,outcome TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id));`);
 }
 /** 记一次"醒来"。run 由心跳引擎产出，这里只负责校验与落库。 */
 record(ctx, run) {
  const s = this.store;
  s.context(ctx, true);
  if (!run || typeof run !== 'object') throw new DomainError('INVALID', '主动做事的记录无效');
  if (!OUTCOMES.includes(run.outcome)) throw new DomainError('INVALID', '记录结果无效');
  if (typeof run.startedAt !== 'string' || !run.startedAt.trim()) throw new DomainError('INVALID', '记录开始时间无效');
  const body = {id: randomUUID(), revision: 1, ...run};
  s.db.prepare('INSERT INTO heartbeat_runs VALUES(?,?,?,?,?)').run(ROOT_SCOPE, body.id, body.startedAt, body.outcome, JSON.stringify(body));
  s.log(ctx, 'heartbeat_recorded', {id: body.id, outcome: body.outcome});
  return body;
 }
 list(ctx, {limit = 20, offset = 0} = {}) {
  this.store.context(ctx);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError('INVALID', '记录查询参数无效');
  const rows = this.store.db.prepare('SELECT body FROM heartbeat_runs WHERE workspace=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(ROOT_SCOPE, limit + 1, offset);
  return {items: rows.slice(0, limit).map(row => JSON.parse(row.body)), nextOffset: rows.length > limit ? offset + limit : null};
 }
 latest(ctx) {
  this.store.context(ctx);
  const row = this.store.db.prepare('SELECT body FROM heartbeat_runs WHERE workspace=? ORDER BY rowid DESC LIMIT 1').get(ROOT_SCOPE);
  return row ? JSON.parse(row.body) : null;
 }
 /** 运行状态：最后成功时间 / 最后一次时间 / 连续失败次数 / 是否需要告警。全部从记录算出来。
  *
  *  `scheduled` 由调用方告诉它"定时到底接没接上" —— 这个值决定**假死能不能判定**：
  *  没接入定时时"多久没醒"没有承诺过，报假死是冤枉它；接上之后才谈得上"该醒没醒"。
  *  2026-10-16 红队实测的缺口正在这里：原来只数"跑了但失败"的连续次数，
  *  **"根本没醒"不会产生任何失败记录**，假死因此永远抓不到（而宪章把假死列为最危险的一种）。 */
 status(ctx, {scheduled = false, intervalMinutes = 0, expectedIntervalHours} = {}) {
  // 唯一事实源（W1 P0-1）：定时是否开启 + 间隔都由调用方从 `heartbeatTiming` 传入。
  // `expectedIntervalHours` 只为旧调用/显示保留派生，不再是"猜"的入口。
  const minutes = Number.isFinite(Number(intervalMinutes)) && Number(intervalMinutes) > 0
   ? Number(intervalMinutes)
   : (Number.isFinite(Number(expectedIntervalHours)) && Number(expectedIntervalHours) > 0 ? Number(expectedIntervalHours) * 60 : 0);
  const expectedHours = minutes > 0 ? minutes / 60 : null;
  this.store.context(ctx);
  const rows = this.store.db.prepare('SELECT body FROM heartbeat_runs WHERE workspace=? ORDER BY rowid DESC LIMIT 100').all(ROOT_SCOPE).map(row => JSON.parse(row.body));
  // 从最近一次往前数连续失败：必须"数前缀"，不能用 findIndex ——
  // findIndex 找的是"第一个失败的位置"，最新一次失败时恒为 0（测试当场抓到过这个错）。
  let consecutiveFailures = 0;
  while (consecutiveFailures < rows.length && rows[consecutiveFailures].outcome !== 'ok') consecutiveFailures += 1;
  const lastSuccess = rows.find(run => run.outcome === 'ok') ?? null;
  const last = rows[0] ?? null;
  // 假死：定时开着、却超过预期间隔没有成功跑过。
  // 它是"该出声"的合法例外之一（宪章第六条补充：连续失败告警），所以并进 alert。
  const lastSuccessAt = lastSuccess?.startedAt ?? null;
  const silentHours = lastSuccessAt ? (Date.now() - Date.parse(lastSuccessAt)) / 3.6e6 : null;
  const stalled = scheduled && minutes > 0 && (silentHours === null || silentHours > expectedHours)
   ? {
     reason: silentHours === null ? '接了定时之后一次都没成功跑过' : '已经 ' + Math.floor(silentHours) + ' 小时没有成功跑过',
     silentHours, expectedIntervalHours: expectedHours, intervalMinutes: minutes, since: lastSuccessAt,
    }
   : null;
  // 「定时是否在跑」必须如实：接了才说接了。
  return {
   scheduled,
   intervalMinutes: minutes,
   expectedIntervalHours: expectedHours,
   // 全站唯一的两套说法（W1 P0-1）：有定时 / 没定时。不再出现"未接入/已在运行/手动触发"三种口径并存。
   scheduledNote: scheduled
    ? '已开启定时：每 ' + minutes + ' 分钟会自己醒一次。'
    : '没有开启定时：要你点一下它才会看一眼。',
   lastRunAt: last?.startedAt ?? null,
   lastSuccessAt,
   lastOutcome: last?.outcome ?? null,
   consecutiveFailures,
   // 沉默多久了（不管有没有失败）—— 让人一眼看出"它是不是根本没醒"。
   silentHours: silentHours === null ? null : Math.round(silentHours * 10) / 10,
   stalled,
   alert: consecutiveFailures >= FAILURE_ALERT_THRESHOLD ? {
    reason: '连续 '+consecutiveFailures+' 次没跑成',
    detail: last?.errors?.map(item => item.message).filter(Boolean).slice(0, 3) ?? [],
    since: rows[consecutiveFailures - 1]?.startedAt ?? last?.startedAt ?? null,
   } : stalled,
   totalRuns: rows.length,
  };
 }
}
