/** 假死判据（F24）。
 *
 *  宪章第六条补充把「假死」列为**最危险**的一种，也是唯一允许的打扰例外。
 *  但 2026-10-16 的红队实测发现：告警只数「跑了但失败」的连续次数 ——
 *  **"根本没醒"不会产生任何失败记录**，于是假死永远抓不到（而它恰恰是最该报警的那种）。
 *
 *  修法：加"沉默多久"的判据，并且**只在接上定时之后才算数** ——
 *  没接定时时"多久没醒"没有承诺过，报假死是冤枉它（诚实要求）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {HeartbeatStore} from '../src/heartbeat-store.mjs';

const ctx = {workspace: 'w', actor: 'test', canWrite: true};
const hoursAgo = hours => new Date(Date.now() - hours * 3.6e6).toISOString();

function storeWith(runs) {
  const store = new WorkstationStore(':memory:');
  const heartbeat = new HeartbeatStore(store);
  for (const run of runs) heartbeat.record(ctx, run);
  return {store, heartbeat};
}

test('没接定时时不报假死（"多久没醒"没有承诺过，报它是冤枉）', () => {
  const {store, heartbeat} = storeWith([{id: 'h-1', startedAt: hoursAgo(100), outcome: 'ok'}]);
  try {
    const status = heartbeat.status(ctx, {scheduled: false});
    assert.equal(status.stalled, null);
    assert.equal(status.alert, null);
    assert.match(status.scheduledNote, /没有开启定时/);
    assert.ok(status.silentHours > 99, '沉默时长仍要如实算出来，方便人一眼看出它是不是没醒');
  } finally { store.close(); }
});

test('接了定时、超过预期间隔没成功跑过 → 必须报假死', () => {
  const {store, heartbeat} = storeWith([{id: 'h-1', startedAt: hoursAgo(50), outcome: 'ok'}]);
  try {
    const status = heartbeat.status(ctx, {scheduled: true, expectedIntervalHours: 24});
    assert.ok(status.stalled, '假死必须被抓到 —— 只数"连续失败"是抓不到"根本没醒"的');
    assert.match(status.stalled.reason, /50 小时|已经/);
    assert.equal(status.alert?.reason, status.stalled.reason, '假死要并进唯一那个告警出口');
  } finally { store.close(); }
});

test('接了定时、刚跑成功过 → 不报假死', () => {
  const {store, heartbeat} = storeWith([{id: 'h-1', startedAt: hoursAgo(1), outcome: 'ok'}]);
  try {
    // 时间相关断言不能贴着阈值：1 小时前跑成 + 60 分钟间隔，测试跑几毫秒后就 >1h，会偶发红。
    assert.equal(heartbeat.status(ctx, {scheduled: true, intervalMinutes: 120}).stalled, null);
  } finally { store.close(); }
});

test('接了定时、一次都没成功过 → 报假死（不是"没记录所以没事"）', () => {
  const {store, heartbeat} = storeWith([{id: 'h-1', startedAt: hoursAgo(2), outcome: 'failed', errors: [{message: '磁盘满'}]}]);
  try {
    const status = heartbeat.status(ctx, {scheduled: true, intervalMinutes: 60});
    assert.ok(status.stalled, '从没成功过 = 假死');
    assert.match(status.stalled.reason, /一次都没成功/);
  } finally { store.close(); }
});

test('连续失败仍然照旧告警，且带上失败原因', () => {
  const {store, heartbeat} = storeWith([
    {id: 'h-2', startedAt: hoursAgo(2), outcome: 'failed', errors: [{message: '磁盘满'}]},
    {id: 'h-1', startedAt: hoursAgo(3), outcome: 'failed', errors: [{message: '磁盘满'}]},
  ]);
  try {
    const status = heartbeat.status(ctx, {scheduled: false});
    assert.equal(status.consecutiveFailures, 2);
    assert.match(status.alert.reason, /连续 2 次没跑成/);
    assert.deepEqual(status.alert.detail, ['磁盘满']);
  } finally { store.close(); }
});
