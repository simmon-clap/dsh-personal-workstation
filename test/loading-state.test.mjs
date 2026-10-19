import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLoading} from '../prototype/loading.mjs';
const shell=()=>{const {JSDOM}=globalThis.__JSDOM__;return new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'))};
const {JSDOM}=await import('../dev-deps.mjs');
globalThis.__JSDOM__={JSDOM};

test('the first paint uses a static skeleton that keeps the layout, not a blank page',()=>{
 const dom=shell(),document=dom.window.document;
 const loading=createLoading(document,{slowAfter:50});
 try{
  loading.begin();
  // 骨架必须复用真实类名，否则网格与高度会跳。
  const metrics=[...document.querySelectorAll('#metrics [data-skeleton]')];
  assert.equal(metrics.length,4,'指标区必须有 4 个骨架，与真实指标卡数量一致');
  assert(metrics.every(node=>node.classList.contains('metric')),'骨架必须用真实的 .metric 类名以保留网格');
  assert(document.querySelectorAll('#projectstrip [data-skeleton]').length===4);
  assert(document.querySelectorAll('#tasksbody [data-skeleton].column').length===3);
  assert(metrics.every(node=>node.getAttribute('aria-hidden')==='true'),'骨架对读屏软件应隐藏');
  assert(!document.querySelector('#loadstate'),'1 秒内不应出现「正在读取资料」');
  assert(loading.active,'进行中必须报告为 active');
 }finally{loading.clear();dom.window.close()}
});
test('after one second a live region says it is reading, and it never shows a fake percentage',async()=>{
 const dom=shell(),document=dom.window.document;
 const loading=createLoading(document,{slowAfter:60});
 try{
  loading.begin();
  await new Promise(resolve=>setTimeout(resolve,120));
  const label=document.querySelector('#loadstate');
  assert(label,'超过阈值必须提示正在读取');
  assert.equal(label.textContent,'正在读取资料');
  assert.equal(label.getAttribute('aria-live'),'polite','状态变化必须通过 aria-live 宣告');
  assert.doesNotMatch(label.textContent,/%/,'不得显示假百分比');
  loading.clear();
  assert(!document.querySelector('#loadstate'),'读完之后提示必须消失');
  assert(!document.querySelector('[data-skeleton]'),'读完之后骨架必须清理干净');
  assert(!loading.active);
 }finally{loading.clear();dom.window.close()}
});
test('a fast load leaves no skeleton and no reading notice behind',async()=>{
 const dom=shell(),document=dom.window.document;
 const loading=createLoading(document,{slowAfter:1000});
 try{
  loading.begin();
  await new Promise(resolve=>setTimeout(resolve,30));
  loading.clear();
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert(!document.querySelector('#loadstate'),'正常加载不该闪出「正在读取资料」');
  assert(!document.querySelector('[data-skeleton]'));
 }finally{loading.clear();dom.window.close()}
});
test('repeated starts do not stack skeletons',()=>{
 const dom=shell(),document=dom.window.document;
 const loading=createLoading(document,{slowAfter:1000});
 try{
  loading.begin();loading.begin();loading.begin();
  assert.equal(document.querySelectorAll('#metrics [data-skeleton]').length,4,'重复进入加载态不得叠加骨架');
 }finally{loading.clear();dom.window.close()}
});
