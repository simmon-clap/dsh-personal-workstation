import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {validateData} from '../src/validation.mjs';
import {createEditor} from '../prototype/editor.mjs';
import {createTaskDetail} from '../prototype/task-detail.mjs';
import {mountOverview} from '../prototype/overview-view.mjs';

// 体检第 3 批 P1/P2/P3：
// ⑤ 任务编辑器在没有所属项目时，把一句超长提示塞进下拉里；
// ⑧ 详情弹窗写「类型 / 记录名」、编辑器写「新建|编辑 / 类型」，两套写法；
// ② 总览「需要解锁」永远显示"等待原因未记录"——即使任务里已经填了等待原因。
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(times=6)=>{for(let i=0;i<times;i+=1)await tick()};
const baseSend=async(action,data={})=>{
 if(action==='list')return {items:data.kind==='project'?[]:(data.kind==='person'?[{id:'pe-1',data:{title:'伙伴 A'}}]:[])};
 if(action==='get')return {item:null};
 if(action==='node_search')return {items:[]};
 throw Error('unexpected '+action);
};
const batch={draft:async()=>({id:'b1'}),open:async()=>{}};

test('the task editor guides you to pick a project instead of stuffing a long sentence into the dropdown',async()=>{
 const dom=shell(),document=dom.window.document;
 const editor=createEditor(document,baseSend,batch,{notify:()=>{}});
 try{
  await editor.open('task');await settle();
  const body=document.querySelector('#detailbody');
  const hidden=body.querySelector('[data-field="deliverableId"]');
  assert(hidden,'所属交付项仍是同一个字段');
  const options=[...hidden.closest('[data-viselect]').querySelectorAll('[data-viselect-option]')].map(node=>node.textContent);
  assert(!options.some(text=>text.includes('该任务还没有所属项目')),'下拉里不允许再出现那句超长提示：'+options.join('、'));
  assert(options.includes('先选所属项目'),'没有项目时下拉里给一句短引导');
  assert.match(body.textContent,/先在上面的「所属项目」里选一个项目/,'真正的引导放在字段下面一行');
 }finally{editor.dispose();dom.window.close()}
});

test('detail dialogs and editors use one title convention: 中文类型 + 记录名',async()=>{
 const dom=shell(),document=dom.window.document;
 const editor=createEditor(document,baseSend,batch,{notify:()=>{}});
 try{
  await editor.open('task');await settle();
  assert.equal(document.querySelector('#detailtype').textContent,'任务','编辑器标题行的类型必须是中文类型（不是"新建"）');
  assert.equal(document.querySelector('#detailtitle').textContent,'新建任务','记录名位写"新建+类型"');
  await editor.open('project',{id:'p1',kind:'project',revision:1,archived:false,data:{title:'联合验证'}});await settle();
  assert.equal(document.querySelector('#detailtype').textContent,'项目');
  assert.equal(document.querySelector('#detailtitle').textContent,'编辑项目');
 }finally{editor.dispose();dom.window.close()}
});

test('a task can record what it is waiting for, and the overview shows the real reason',async()=>{
 assert.doesNotThrow(()=>validateData('task',{title:'跟进试点',status:'waiting',blockedReason:'等伙伴 A 的接口文档'}),'blockedReason 必须能写');
 assert.throws(()=>validateData('task',{title:'T',blockedReason:123}),/blockedReason/,'必须是文本');
 assert.throws(()=>validateData('task',{title:'T',blockedReason:{}}),/blockedReason/);
 // 编辑器里可填可改
 const dom=shell(),document=dom.window.document;
 const editor=createEditor(document,baseSend,batch,{notify:()=>{}});
 try{
  await editor.open('task',{id:'t1',kind:'task',revision:1,archived:false,data:{title:'跟进试点',status:'waiting',blockedReason:'等接口文档'}});
  await settle();
  const field=document.querySelector('#detailbody [data-field="blockedReason"]');
  assert(field,'任务编辑器必须有「等待原因」');
  assert.equal(field.value,'等接口文档','已有原因必须回填');
 }finally{editor.dispose();dom.window.close()}
});

test('the task detail states the waiting reason, and says 原因未记录 when empty',async()=>{
 const cases=[['等伙伴 A 的接口文档','等伙伴 A 的接口文档'],[undefined,'原因未记录']];
 for(const [blockedReason,expected] of cases){
  const dom=shell(),document=dom.window.document;
  const item={id:'t1',kind:'task',revision:1,archived:false,data:{title:'跟进试点',status:'waiting',...(blockedReason?{blockedReason}:{})}};
  const send=async(action)=>{if(action==='get')return {item};if(action==='list')return {items:[]};if(action==='execution_history')throw Error('未接入');throw Error(action)};
  const detail=createTaskDetail(document,send,{openProject:()=>{},onEdit:()=>{},openCanvas:()=>{}});
  try{
   await detail.open('t1');await settle();
   const field=document.querySelector('#detailbody [data-inline-field="等待原因"]');
   assert.ok(field,'任务详情必须有「等待原因」这一项（且可就地编辑）');
   assert.equal(field.querySelector('.inlinevalue')?.textContent?.trim(),expected,'任务详情必须如实显示等待原因；没填就写"原因未记录"');
  }finally{detail.dispose();dom.window.close()}
 }
});

test('the overview 需要解锁 metric shows recorded reasons, and only says 原因未记录 when none exist',async()=>{
 const withReason=[
  {id:'p1',kind:'project',archived:false,data:{title:'联合验证',deliverables:[{id:'d',title:'D',done:false}]}},
  {id:'t1',kind:'task',archived:false,data:{title:'跟进试点',status:'waiting',projectId:'p1',blockedReason:'等伙伴 A 的接口文档'}},
 ];
 const withoutReason=[withReason[0],{id:'t1',kind:'task',archived:false,data:{title:'跟进试点',status:'waiting',projectId:'p1'}}];
 const render=async items=>{
  const dom=shell(),document=dom.window.document;
  const view=mountOverview(document,items,{pending:0,openEvent:()=>{},openTopic:()=>{}});
  await tick();
  const text=document.querySelector('#metrics').textContent;
  view.dispose?.();dom.window.close();
  return text;
 };
 const shown=await render(withReason);
 assert.match(shown,/等伙伴 A 的接口文档/,'填了原因就显示真实原因');
 assert.doesNotMatch(shown,/等待原因未记录/,'有原因时不能再说"未记录"');
 const empty=await render(withoutReason);
 assert.match(empty,/原因未记录/,'确实没填时才写"原因未记录"');
});
