import {ROOT_SCOPE} from './scope.mjs';
import {DomainError} from './store.mjs';

/** 常驻节点心跳（宪章 v1.4 第七条 · spec/13 §10 · spec/17 C8 v1.1）。
 *
 *  ## 为什么是"记账"而不是"探活"
 *  原来 `dsh-sync.sh` 用 `ssh -o ConnectTimeout=8` 判断对端在不在。2026-10-21 实测：
 *  Tailscale 走中继时 8 秒不是够用的时长，于是报出「对端不可达」，而常驻节点其实在线；
 *  更糟的是这句"不可达"被写成「跳过这次（**不算失败**）」，既不告警也不留可判读的记录，
 *  而真正的故障是**本机定时任务从 10-19 起就没再跑**（约 55 小时无人知）。
 *
 *  探活回答的是"我这一跳通不通"，记账回答的是"它有没有按时醒" —— 后者才是承诺的对象。
 *
 *  ## 承诺是不对称的
 *  只有常驻节点承担"必须在线"；笔记本、手机不可达是常态，**不记失败**。
 *  所以本模块只给被标记为常驻的那一侧判定，别的侧只记录、不判红。
 */

/** 心跳间隔（分钟）。与 `dsh-sync.sh` 的 StartInterval 保持一致。 */
export const BEAT_INTERVAL_MINUTES = 15;
/** 超过 N 个周期没醒就算故障（3 个周期 = 45 分钟）。 */
export const STALE_FACTOR = 3;

/** 纯函数：给它最后一条心跳，判断"它现在算不算醒着"。
 *  不碰存储、不看时钟以外的东西 —— 这样能被单测与门禁直接喂夹具。 */
export function judgeBeat({lastAt = null, now = new Date(), intervalMinutes = BEAT_INTERVAL_MINUTES} = {}) {
 const limit = Math.max(1, Math.floor(intervalMinutes)) * STALE_FACTOR;
 if (!lastAt) {
  return {state: 'never', silentMinutes: null, intervalMinutes, staleAfterMinutes: limit,
   note: '接上常量节点之后一次都没有记过心跳'};
 }
 const at = Date.parse(lastAt);
 if (!Number.isFinite(at)) {
  return {state: 'never', silentMinutes: null, intervalMinutes, staleAfterMinutes: limit,
   note: '最后一条心跳的时间读不懂，不能据此判断它还醒着'};
 }
 const silentMinutes = Math.max(0, Math.round((now.getTime() - at) / 60000));
 if (silentMinutes > limit) {
  return {state: 'stale', silentMinutes, intervalMinutes, staleAfterMinutes: limit, lastAt,
   note: '已经 ' + silentMinutes + ' 分钟没有心跳（承诺是每 ' + intervalMinutes + ' 分钟一次，超过 ' + limit + ' 分钟算停）'};
 }
 return {state: 'ok', silentMinutes, intervalMinutes, staleAfterMinutes: limit, lastAt, note: '每 ' + intervalMinutes + ' 分钟一次，最近一次在 ' + silentMinutes + ' 分钟前'};
}

/** 心跳记录表（与 heartbeat_runs / speak_feedback 同类：**运行记录，不是业务对象**）。
 *
 *  为什么不塞进 heartbeat_runs：心跳回答"它有没有醒"，留痕回答"醒来做了什么"，
 *  两者频率与用途都不同（前者每 15 分钟一条、要支持跨端判活；后者每次醒来一条、要写结论）。
 *  混在一张表里，"判活"就得扫全量结论，且两端的写入会互相污染。
 */
export class BeatStore {
 constructor(store) {
  this.store = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS beat(
   workspace TEXT NOT NULL,
   side TEXT NOT NULL,
   seq INTEGER NOT NULL,
   at TEXT NOT NULL,
   source TEXT NOT NULL,
   PRIMARY KEY(workspace,side,seq));`);
 }

 /** 记一笔心跳。seq 按 (工作区, 侧) 单调递增 —— 判活只需要"最新那条"，不必依赖墙钟。 */
 append(ctx, {side = 'resident', source = 'timer', at = new Date().toISOString()} = {}) {
  const s = this.store;
  s.context(ctx, true);
  if (typeof side !== 'string' || !side.trim() || side.length > 40) throw new DomainError('INVALID', '心跳来自哪一侧无效');
  if (typeof source !== 'string' || !source.trim() || source.length > 40) throw new DomainError('INVALID', '心跳来源无效');
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new DomainError('INVALID', '心跳时间无效');
  const row = s.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM beat WHERE workspace=? AND side=?').get(ROOT_SCOPE, side.trim());
  const seq = Number(row?.next ?? 1);
  s.db.prepare('INSERT INTO beat(workspace,side,seq,at,source) VALUES(?,?,?,?,?)')
   .run(ROOT_SCOPE, side.trim(), seq, at, source.trim());
  return {side: side.trim(), seq, at, source: source.trim()};
 }

 /** 最新一条（可选按侧）。 */
 last(ctx, {side = null} = {}) {
  this.store.context(ctx);
  const row = side
   ? this.store.db.prepare('SELECT side,seq,at,source FROM beat WHERE workspace=? AND side=? ORDER BY seq DESC LIMIT 1').get(ROOT_SCOPE, side)
   : this.store.db.prepare('SELECT side,seq,at,source FROM beat WHERE workspace=? ORDER BY rowid DESC LIMIT 1').get(ROOT_SCOPE);
  return row ? {side: row.side, seq: row.seq, at: row.at, source: row.source} : null;
 }

 /** 某一侧最近 N 条（排查用）。 */
 list(ctx, {side = 'resident', limit = 20} = {}) {
  this.store.context(ctx);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID', '心跳查询条数无效');
  return this.store.db.prepare('SELECT side,seq,at,source FROM beat WHERE workspace=? AND side=? ORDER BY seq DESC LIMIT ?')
   .all(ROOT_SCOPE, side, limit).map(row => ({side: row.side, seq: row.seq, at: row.at, source: row.source}));
 }

 /** 判活：给界面与门禁用的一处结论。
   * `residentSide` 由调用方告诉它"本机到底是不是常驻" —— 这个值决定**能不能判红**：
   * 笔记本上不能因为"我看不到常驻节点"就报故障，那是常态（宪章 v1.4 承诺不对称）。 */
 state(ctx, {residentSide = 'resident', intervalMinutes = BEAT_INTERVAL_MINUTES, now = new Date()} = {}) {
  this.store.context(ctx);
  const last = this.last(ctx, {side: residentSide});
  const judged = judgeBeat({lastAt: last?.at ?? null, now, intervalMinutes});
  return {...judged, side: residentSide, lastBeatAt: last?.at ?? null, lastSource: last?.source ?? null,
   // 只有"这一侧就是常驻"时，stale 才是故障；否则只是"我看不到它"。判断留在这里，免得每处各自解释一遍。
   fault: judged.state !== 'ok',
   note: judged.state === 'never' && !last ? '还没有任何心跳记录（常驻节点是否已启动？）' : judged.note};
 }
}
