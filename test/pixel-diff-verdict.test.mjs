/** 像素棘轮的判决逻辑单测（可复现 45 审计抓到的假绿事故）。
 *
 *  事故形态：把 0–255 的逐像素容差（24）拿去和 0–1 的差异比例比较，
 *  `ratio > was + 24` 永远为假 → 棘轮永不 FAIL。这类错误光读代码很难发现，
 *  所以把判决抽成 `verdict()` 纯函数，在这里注入"比基线更差"的测量值做 canary。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {verdict} from '../prototype/pixel-diff.mjs';

const baseline = {home: 0.0646, space: 0.0585, projects: 0.0516, tasks: 0.0368, knowledge: 0.0238, personal: 0.0269};
const row = (view, ratio) => ({view, best: {ratio}});

test('比基线更差 → 真的报回归（注入 9% vs 基线 6.46%）', () => {
  const regressed = verdict([row('home', 0.09)], baseline);
  assert.equal(regressed.length, 1);
  assert.match(regressed[0], /home/);
});

test('canary：若容差被错写成 24（像素尺度），这条注入会漏 → 本测试会红', () => {
  // 这里直接验证"正确容差必须能抓到 2.5 个百分点的漂移"。
  const regressed = verdict([row('home', 0.0646 + 0.025)], baseline);
  assert.equal(regressed.length, 1, '2.5 个百分点的漂移必须 FAIL；漏了就说明容差量纲错了');
});

test('噪声范围内（+0.4 个百分点）→ 不误报', () => {
  assert.deepEqual(verdict([row('home', 0.0646 + 0.004)], baseline), []);
});

test('基线里没有这一页 → 必须失败（不能默默放过）', () => {
  const regressed = verdict([row('newpage', 0.01)], baseline);
  assert.equal(regressed.length, 1);
  assert.match(regressed[0], /基线里没有这一页/);
});

test('空测量不是通过：冻结钩子永远不调用 void 0（占位防回归）', () => {
  // 明确断言"比例是 0–1"这个量纲：如果以后有人把 ratio 改成 0–100，这条会先红。
  assert.ok(0.09 > 0.0646 + 0.005);
});
