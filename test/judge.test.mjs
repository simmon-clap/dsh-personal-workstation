import {test} from 'node:test';
import assert from 'node:assert/strict';
import {threeAnswers, selectForAnchor, anchorOf} from '../src/judge.mjs';

/** 判断层（spec/03 §6 ⑨ 三问 · spec/55 P3）的验收：
 *  - 三问缺一不可，缺哪问要说出来；
 *  - 一次最多 5 条（用户 D5），超出的写清为什么没进去；
 *  - 同一件事只出一次。 */

const candidate = overrides => ({
 rule: '守承诺', subjectId: 't-1', title: '交周报', what: '交付日期 2026-10-22',
 why: '今天到期', level: 2, overdue: false, ...overrides,
});

test('三问齐全才是建议', () => {
 const {ok, item} = threeAnswers(candidate());
 assert.equal(ok, true);
 assert.equal(item.changed, '交付日期 2026-10-22');
 assert.equal(item.means, '今天到期');
 assert.equal(item.verb, '打开这件事');
 assert.equal(item.target, 't-1');
});

test('缺「能做什么」= 通知，不许装作建议', () => {
 const result = threeAnswers(candidate({subjectId: null, rule: '没登记过的规则'}));
 assert.equal(result.ok, false);
 assert.deepEqual(result.missing, ['能做什么']);
});

test('缺「意味着什么」= 播报，同样拦住', () => {
 const result = threeAnswers(candidate({why: '   '}));
 assert.equal(result.ok, false);
 assert.deepEqual(result.missing, ['意味着什么']);
});

test('一次最多 5 条，超出的写清为什么没进去', () => {
 const many = Array.from({length: 8}, (_, index) => candidate({subjectId: 't-' + index}));
 const picked = selectForAnchor(many, {cap: 5});
 assert.equal(picked.items.length, 5);
 assert.equal(picked.skipped.filter(item => /排不进/.test(item.why)).length, 3);
 assert.match(picked.summary, /5 条/);
});

test('同一件事只出一次（两条规则命中同一对象）', () => {
 const picked = selectForAnchor([candidate(), candidate({rule: '盯依赖', why: '依赖解锁'})], {cap: 5});
 assert.equal(picked.items.length, 1);
});

test('级高的排前面', () => {
 const picked = selectForAnchor([candidate({subjectId: 'low', level: 1}), candidate({subjectId: 'high', level: 2})], {cap: 5});
 assert.deepEqual(picked.items.map(item => item.id), ['high', 'low']);
});

test('开口点：09:30 与 21:00 各有 30 分钟窗口', () => {
 const morning = new Date('2026-10-22T09:40:00+08:00');
 const evening = new Date('2026-10-22T21:10:00+08:00');
 assert.equal(anchorOf(morning), 'morning');
 assert.equal(anchorOf(evening), 'evening');
 assert.equal(anchorOf(new Date('2026-10-22T14:00:00+08:00')), null);
 assert.equal(anchorOf(new Date('2026-10-22T10:05:00+08:00')), null, '过了 30 分钟窗口就不算这个锚点');
 assert.equal(anchorOf(new Date('2026-10-22T09:31:00+08:00')), 'morning', '窗口内的抖动要接住');
});
