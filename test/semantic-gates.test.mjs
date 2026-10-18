/** 语义门禁判据的回归测试（17 §3）。
 *
 *  分工：
 *    · 这里测「判据逻辑」——干净数据必须 0 违规；每条判据注入一处违规必须真的红（canary）。
 *    · 真实界面上的测量由 `prototype/semantic-gates.mjs` 跑（不进 verify，因为它依赖正在运行的实例）。
 *
 *  为什么要这层：17 号约束 C3 写明「门禁必须真的有 canary；发现假绿按 P0 处理」。
 *  判据写错（阈值量纲、字段名拼错、空扫描）时，真实脚本会静默 PASS —— 这里的 canary 先把它拦住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {CHECKS, runChecks, cleanFixture, canaryReport} from '../prototype/semantic-checks.mjs';

test('判据清单覆盖 17 §3 的 10 项可机械化项（S9/S13 是人工验收，不在此列）', () => {
  assert.deepEqual(CHECKS.map(c => c.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S10', 'S12']);
});

test('干净夹具：10 项判据全部 0 违规（否则后面所有 canary 都证明不了什么）', () => {
  const results = runChecks(cleanFixture());
  for (const row of results) assert.equal(row.count, 0, row.id + ' 在干净夹具上误报：' + JSON.stringify(row.violations).slice(0, 200));
});

test('canary：每条判据注入一处违规都能抓到（10/10）', () => {
  const report = canaryReport();
  const missed = report.filter(r => !r.caught);
  assert.deepEqual(missed.map(r => r.id + ' ' + r.why), []);
  assert.equal(report.length, CHECKS.length);
});

test('违规计数不是固定值：注入越多，计数越大', () => {
  const data = cleanFixture();
  data.views.home.headings.push({tag: 'H2', text: '坏', size: '15px', weight: '600', class: ''});
  const one = runChecks(data).find(r => r.id === 'S1').count;
  data.views.home.headings.push({tag: 'H2', text: '坏 2', size: '15px', weight: '600', class: ''});
  const two = runChecks(data).find(r => r.id === 'S1').count;
  assert.ok(two > one, '第二处违规没有让计数增加：' + one + ' → ' + two);
});
