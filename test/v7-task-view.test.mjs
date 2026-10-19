import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from '../dev-deps.mjs';import {mountTaskViews,taskModels} from '../prototype/task-view.mjs';
test('V7 task tabs and original target filters keep real dependencies and steps',()=>{const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));const items=[{id:'p',kind:'project',data:{title:'P'}},{id:'a',kind:'task',data:{title:'A',projectId:'p',executionTarget:'mini',status:'waiting',steps:[{done:false},{done:true}]}},{id:'b',kind:'task',data:{title:'B',status:'in_progress',dependsOn:['a']}}],opened=[];const view=mountTaskViews(dom.window.document,items,id=>opened.push(id));try{const doc=dom.window.document;doc.querySelector('#taskfilters [data-target="Mini"]').click();assert.equal(doc.querySelectorAll('#tasksbody [data-task]').length,1);doc.querySelector('#taskfilters [data-target="all"]').click();doc.querySelector('#tasktabs button:not([data-tmode="board"])').click();assert.match(doc.querySelector('#tasksbody').textContent,/A/);doc.querySelector('#tasksbody [data-task="b"]').click();assert.deepEqual(opened,['b']);assert.equal(taskModels(items)[1].state,'运行中');assert.equal(taskModels(items)[1].executionStatus,null);assert.equal(taskModels(items)[0].steps[1].done,true);}finally{view.dispose();dom.window.close()}});

// ── W1 P0-3：真实数据里 5 条任务全是「待办」、其余三列全空 ────────────────────────
// 46 号审计实测：四个 0 指标 + 「待办 · 5」排在第 4 列 + 每张卡一个 68px 空环 + 手机首屏 0 条任务。
// 这些断言就是 26 §4 P0-3 的完成判据（T3-1…T3-6、T3-10）。
import {JSDOM as JSDOM2} from '../dev-deps.mjs';

const shellDoc=()=>new JSDOM2(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const todoTasks=()=>Array.from({length:5},(_,index)=>({id:'t'+index,kind:'task',data:{title:'待办任务 '+index,status:'todo',executionTarget:'local'}}));

test('P0-3 指标区只显示有内容的项，待办排第一（T3-1/T3-9）',()=>{
 const dom=shellDoc();const view=mountTaskViews(dom.window.document,todoTasks(),()=>{});
 try{
  const doc=dom.window.document;
  const metrics=[...doc.querySelectorAll('#taskmetrics .metric')];
  assert.equal(metrics.length,1,'5 条待办、0 步骤 → 只能有一张指标卡（旧版是 4 张）');
  assert.match(metrics[0].textContent,/待办/);
  assert.match(metrics[0].textContent,/5/);
  assert.doesNotMatch(doc.querySelector('#taskmetrics').textContent,/当前筛选/,'副文案不得重复四次');
  assert.doesNotMatch(doc.querySelector('#taskmetrics').textContent,/0\/0/,'0/0 步骤不渲染');
 }finally{view.dispose();dom.window.close()}
});

test('P0-3 看板只渲染有内容的列、待办第一列、空列折叠一行（T3-2/T3-3/T3-10）',()=>{
 const dom=shellDoc();const view=mountTaskViews(dom.window.document,todoTasks(),()=>{});
 try{
  const doc=dom.window.document;
  const columns=[...doc.querySelectorAll('#tasksbody .column')];
  assert.equal(columns.length,1,'三个空列不得占宽（旧版 4 列里 3 列是空的）');
  assert.match(columns[0].querySelector('h3').textContent,/^待办 · 5$/,'待办必须排在第一列');
  assert.equal(columns[0].querySelectorAll('[data-task]').length,5);
  assert.doesNotMatch(doc.querySelector('#tasksbody').textContent,/当前没有任务/,'空列不得再写这一句');
  const collapsed=doc.querySelector('[data-emptycolumns]');
  assert(collapsed,'空列必须折叠成一行');
  assert.match(collapsed.textContent,/等待中/);
  assert.match(collapsed.textContent,/运行中/);
  assert.match(collapsed.textContent,/已完成/);
  assert.equal(doc.querySelectorAll('#tasksbody svg.ring').length,0,'0 步骤的卡不得画 68px 空环');
 }finally{view.dispose();dom.window.close()}
});

test('P0-3 有步骤时步骤指标与环按真实数据出现（T3-5）',()=>{
 const dom=shellDoc();
 const items=[{id:'a',kind:'task',data:{title:'有步骤',status:'todo',steps:[{done:true},{done:false}]}},
  {id:'b',kind:'task',data:{title:'无步骤',status:'todo'}}];
 const view=mountTaskViews(dom.window.document,items,()=>{});
 try{
  const doc=dom.window.document;
  const metrics=doc.querySelector('#taskmetrics').textContent;
  assert.match(metrics,/步骤完成/);
  assert.match(metrics,/1\/2/,'步骤完成必须是真实值');
  assert.equal(doc.querySelectorAll('#tasksbody svg.ring').length,1,'只有有步骤的那张卡画环');
  assert.equal(doc.querySelectorAll('#tasksbody [data-task="a"] svg.ring').length,1);
  assert.equal(doc.querySelectorAll('#tasksbody [data-task="b"] svg.ring').length,0);
 }finally{view.dispose();dom.window.close()}
});

test('P0-3 筛空时不显示 0 指标，空态给「清除筛选」并能恢复（T3-6）',()=>{
 const dom=shellDoc();const view=mountTaskViews(dom.window.document,todoTasks(),()=>{});
 try{
  const doc=dom.window.document;
  const mini=doc.querySelector('#taskfilters [data-target="Mini"]');
  assert(mini,'前置条件：执行位置筛选存在');
  mini.click();
  assert.equal(doc.querySelectorAll('#tasksbody [data-task]').length,0);
  assert.equal(doc.querySelector('#taskmetrics').textContent.trim(),'','筛空时指标区必须清空');
  assert.equal(doc.querySelector('#taskmetrics').style.display,'none','筛空时指标区不得留空壳');
  const empty=doc.querySelector('#tasksbody .v7-empty');
  assert(empty,'必须给出空态说明');
  const clear=[...empty.querySelectorAll('button')].find(node=>/清除筛选/.test(node.textContent));
  assert(clear,'空态必须给一个下一步（清除筛选）');
  clear.click();
  assert.equal(doc.querySelectorAll('#tasksbody [data-task]').length,5,'清除筛选后恢复全部任务');
 }finally{view.dispose();dom.window.close()}
});

test('P0-3 一条任务都没有时给「新建任务」下一步（onCreate）',()=>{
 const dom=shellDoc();let created=0;
 const view=mountTaskViews(dom.window.document,[],()=>{},{onCreate:()=>{created+=1}});
 try{
  const doc=dom.window.document;
  const empty=doc.querySelector('#tasksbody .v7-empty');
  assert(empty,'没有任务时必须有空态');
  const create=[...empty.querySelectorAll('button')].find(node=>/新建任务/.test(node.textContent));
  assert(create,'空态必须能新建任务');
  create.click();
  assert.equal(created,1,'点新建任务必须真的触发编辑入口');
 }finally{view.dispose();dom.window.close()}
});
