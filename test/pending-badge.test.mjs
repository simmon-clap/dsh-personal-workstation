import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {mountPendingBadge} from '../prototype/pending-badge.mjs';
// 用**构建产物**：收件箱现在是构建期注入的**侧栏顶部入口**（用户 2026-10-12 授权从「知识」页签挪出来），原型夹具里没有。
const shell=()=>new JSDOM(readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8'));

test('the pending count shows up where the user looks, and comes from real data',()=>{
 const dom=shell(),document=dom.window.document;
 const badge=mountPendingBadge(document,{count:3});
 try{
  const sidebar=document.querySelector('.nav [data-view="inbox"] [data-pending-badge]');
  assert(sidebar,'侧栏「收件箱」必须显示待确认数量（入口提到顶部后，数字跟着挪到用户处理队列的地方）');
  assert.equal(sidebar.textContent,'3');
  assert.equal(document.querySelector('#knowtabs [data-know="inbox"]'),null,'知识页签里不再留第二个收件箱入口');
  // 数字不能只靠颜色表达：读屏要能听到完整句子
  assert.match(document.querySelector('.nav [data-view="inbox"]').getAttribute('aria-label'),/收件箱，3 条待确认/);
  assert.equal(sidebar.getAttribute('aria-hidden'),'true','徽标本身对读屏隐藏，避免重复播报');
 }finally{badge.clear();dom.window.close()}
});
test('no pending work means no badge at all, and a reload cannot stack badges',()=>{
 const dom=shell(),document=dom.window.document;
 const badge=mountPendingBadge(document,{count:2});
 try{
  assert.equal(document.querySelectorAll('[data-pending-badge]').length,1);
  badge.render(5);
  assert.equal(document.querySelectorAll('[data-pending-badge]').length,1,'重复渲染不得叠加');
  assert.equal(document.querySelector('.nav [data-view="inbox"] [data-pending-badge]').textContent,'5');
  badge.render(0);
  assert.equal(document.querySelectorAll('[data-pending-badge]').length,0,'没有待确认就不显示徽标');
  assert(!document.querySelector('.nav [data-view="inbox"]').hasAttribute('aria-label'),'徽标消失后不应残留 aria-label');
  badge.render(undefined);
  assert.equal(document.querySelectorAll('[data-pending-badge]').length,0,'读不到数量时不显示（不得写死）');
 }finally{badge.clear();dom.window.close()}
});
test('the badge uses the VI palette instead of inventing colours',()=>{
 const css=readFileSync(new URL('../prototype/v7-workbench.css',import.meta.url),'utf8');
 const tokens=JSON.parse(readFileSync(new URL('../design-system/tokens.json',import.meta.url),'utf8'));
 const allowed=new Set([...Object.values(tokens.color),...Object.values(tokens.dark)].map(value=>value.toUpperCase()));
 const block=css.slice(css.indexOf('.ws-badge'),css.indexOf('.ws-badge')+400);
 for(const match of block.matchAll(/#[0-9A-Fa-f]{6}/g))assert(allowed.has(match[0].toUpperCase()),'徽标用了 VI 之外的色值：'+match[0]);
 assert.match(block,/tabular-nums/,'数字必须等宽，避免跳动');
});
