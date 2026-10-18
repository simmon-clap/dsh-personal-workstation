import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from '../dev-deps.mjs';import {mountTaskViews,taskModels} from '../prototype/task-view.mjs';

/**
 * 任务列表的「负责人」筛选（第 3 批 P1-1，方案 A）。
 * 口径（Lead 裁定）：选项 = 全部 / 未指定负责人 / 真实出现过的负责人姓名；
 * "未指定负责人" = ownerId 缺失，**或**指向已归档/不存在的 person 记录；
 * **界面不出现"我"**——插件没有"当前操作者 → person 记录"的映射，不许用最近操作者 id 猜。
 */
function render(){
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const items=[
  {id:'p1',kind:'project',data:{title:'P1'}},
  {id:'alice',kind:'person',data:{title:'爱丽丝'}},
  {id:'bob',kind:'person',data:{title:''}},                              // 没有名称 → 退 id 并标注
  {id:'gone',kind:'person',data:{title:'已归档的人'},archived:true},      // 已归档 → 视为未指定
  {id:'t1',kind:'task',data:{title:'T-爱丽丝',projectId:'p1',ownerId:'alice',status:'todo'}},
  {id:'t2',kind:'task',data:{title:'T-bob',projectId:'p1',ownerId:'bob',status:'todo'}},
  {id:'t3',kind:'task',data:{title:'T-没填负责人',projectId:'p1',status:'todo'}},
  {id:'t4',kind:'task',data:{title:'T-负责人已归档',projectId:'p1',ownerId:'gone',status:'todo'}},
  {id:'t5',kind:'task',data:{title:'T-负责人不存在',projectId:'p1',ownerId:'nope',status:'todo'}},
 ];
 const view=mountTaskViews(dom.window.document,items,()=>{});
 const doc=dom.window.document;
 const shown=()=>[...doc.querySelectorAll('#tasksbody [data-task]')].map(node=>node.dataset.task).sort();
 const choose=value=>{const select=doc.querySelector('#taskowner');select.value=value;select.dispatchEvent(new dom.window.Event('change'));};
 return {dom,doc,items,view,shown,choose};
}
test('task list exposes the owner id on the model so the filter has real data',()=>{
 const {dom,items,view}=render();
 try{
  assert.equal(taskModels(items).find(model=>model.id==='t1').ownerId,'alice','任务模型必须带上 ownerId，否则筛选无据可依');
 }finally{view.dispose();dom.window.close()}
});
test('the task toolbar filters by real owner records, states 未指定 explicitly and never offers 我',()=>{
 const {dom,doc,view,shown,choose}=render();
 try{
  const select=doc.querySelector('#taskowner');
  assert.ok(select,'任务列表工具栏必须有「负责人」筛选');
  assert.equal(select.closest('#taskfilters')!==null,true,'负责人筛选要挂在既有任务筛选容器里（逐控件审计按容器判定接线）');
  // 下拉已统一成 VI 选择控件（门禁 4）：选项在浮层列表里，不再是原生 option。

  const labels=[...doc.querySelectorAll('#taskownerselect [data-viselect-option]')].map(option=>option.textContent);
  assert.deepEqual(labels,['全部负责人','未指定负责人','爱丽丝','bob（名称未记录）'],'选项只来自真实记录；没有名称就退 id 并标注');
  assert.equal(labels.some(label=>label.includes('我')),false,'不提供"我"：没有操作者到 person 记录的映射，不许猜');
  assert.deepEqual(shown(),['t1','t2','t3','t4','t5'],'默认全部负责人');
  choose('alice');
  assert.deepEqual(shown(),['t1'],'按负责人筛选只留该负责人的任务');
  choose('bob');
  assert.deepEqual(shown(),['t2'],'没有名称的负责人仍按 id 正常筛选');
  choose('__none__');
  assert.deepEqual(shown(),['t3','t4','t5'],'未指定负责人＝没填、或指向已归档/不存在的记录');
  choose('');
  assert.deepEqual(shown(),['t1','t2','t3','t4','t5'],'切回全部负责人');
  // 与执行位置筛选叠加时两个条件都要生效
  doc.querySelector('#taskfilters [data-target="Mini"]').click();
  assert.deepEqual(shown(),[],'执行位置筛选叠加后不应漏过 Mini 之外的任务');
 }finally{view.dispose();dom.window.close()}
});
test('empty state explains the owner filter instead of pretending there are no tasks',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const items=[{id:'p1',kind:'project',data:{title:'P1'}},{id:'alice',kind:'person',data:{title:'爱丽丝'}},{id:'t1',kind:'task',data:{title:'T1',projectId:'p1',ownerId:'alice',executionTarget:'mini',status:'todo'}}];
 const view=mountTaskViews(dom.window.document,items,()=>{});
 const doc=dom.window.document;
 try{
  const select=doc.querySelector('#taskowner');
  select.value='__none__';select.dispatchEvent(new dom.window.Event('change'));
  assert.match(doc.querySelector('#tasksbody').textContent,/未指定负责人/,'筛空时要说明是负责人筛选造成的，而不是说没有任务');
 }finally{view.dispose();dom.window.close()}
});
