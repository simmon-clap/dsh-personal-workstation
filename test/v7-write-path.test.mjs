import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createBatchFlow} from '../prototype/batch.mjs';
import {createEditor} from '../prototype/editor.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('V7 create flow drafts, previews, commits and undoes through real persistence',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const batch=createBatchFlow(document,send,{notify:(text,error)=>notes.push([text,error]),confirm:()=>true,onCommitted:()=>{}});
 const editor=createEditor(document,send,batch,{notify:(text,error)=>notes.push([text,error])});
 try{
  await editor.menu();
  assert.equal(document.querySelector('#detailtitle').textContent,'新建');
  const kinds=[...document.querySelectorAll('#detailbody [data-kind]')].map(node=>node.querySelector('h2').textContent);
  // 登记表里的对象类型都能在这里新建（人机共用录入，PRD v1.1 核心决定）；判断已于批次 1 登记。
  assert.equal(kinds.length,9);
  assert.ok(kinds.includes('判断'),'新建菜单必须列出「判断」，否则界面上根本建不了判断');
  document.querySelector('#detailbody [data-kind="project"]').click();await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'新建项目');
  document.querySelector('[data-field="title"]').value='真实项目';
  document.querySelector('[data-field="goal"]').value='验证目标';
  document.querySelector('[data-field="startDate"]').value='2026-03-01';
  document.querySelector('#objadditem').click();
  const row=document.querySelector('#objchecklist [data-role="itemtitle"]');row.value='交付项一';
  // 你自己填的表单：保存即生效（不再让你为自己的操作点同意），并给一条「已保存 · 撤销」。
  document.querySelector('#objpreview').click();await tick();await tick();await tick();
  const saved=store.list({workspace:'w',actor:'t'});
  assert.equal(saved.length,1,'保存后应立刻有且只有一条记录');
  assert.equal(saved[0].data.title,'真实项目');assert.equal(saved[0].data.deliverables[0].title,'交付项一');
  const bar=document.querySelector('#undobar');
  assert(bar&&!bar.hidden,'必须出现「已保存 · 撤销」');
  bar.querySelector('[data-undobutton]').click();await tick();await tick();await tick();
  assert.equal(store.list({workspace:'w',actor:'t'}).filter(item=>!item.archived).length,0,'撤销后这条记录应失效');
  assert.equal(store.list({workspace:'w',actor:'t'}).filter(item=>!item.archived).length,0,'撤销后记录应失效');
  assert.deepEqual(notes.filter(([,error])=>error),[]);
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
test('取消勾选后点「同意所选」，只写入选中的那些（不必先重新预览）',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  const draft=await send('draft',{title:'两项',changes:[{op:'create',id:'a',kind:'topic',data:{title:'A'}},{op:'create',id:'b',kind:'topic',data:{title:'B'}}]});
  await batch.open(draft.id);
  // 默认全选：按钮就是"全部同意"
  assert.equal(document.querySelector('#batchCommit').disabled,false);
  assert.match(document.querySelector('#batchCommit').textContent,/全部同意/);
  // 取消第二项：按钮变成"同意所选"，仍然是可点的（旧版要求先"保存取舍并重新预览"，用户看不懂）
  const second=document.querySelector('[data-keep="1"]');
  second.checked=false;second.onchange();
  assert.equal(document.querySelector('#batchCommit').disabled,false,'取消勾选后仍可直接同意所选');
  assert.match(document.querySelector('#batchCommit').textContent,/同意所选（1 项）/);
  assert.equal(document.querySelector('#batchApply'),null,'不再有"保存取舍并重新预览"这种按钮');
  document.querySelector('#batchCommit').click();await tick();await tick();
  assert.deepEqual(store.list({workspace:'w',actor:'t'}).map(x=>x.data.title),['A'],'只写入选中的那一项');
 }finally{batch.dispose();store.close();dom.window.close()}
});

test('V7 editor normalizes local times and still rejects junk before creating a draft',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:(text,error)=>notes.push([text,error])});
 try{
  // ① 本地时间（界面提示就是这种写法）→ 自动补本机时区偏移，可以正常建草稿。
  //    以前这里一律拒绝，等于"定时事务根本存不进去"。
  await editor.open('event');await tick();
  document.querySelector('[data-field="title"]').value='本地时间会议';
  document.querySelector('[data-field="startDate"]').value='2026-03-01T09:00';
  document.querySelector('#objpreview').click();await tick();
  const boxed=store.inbox({workspace:'w',actor:'t'});
  assert.equal(boxed.length,1,'本地时间应当被规范化后建待确认的改动');
  const created=boxed[0].changes[0].data;
  assert.match(created.startDate,/^2026-03-01T09:00:00[+-]\d{2}:\d{2}$/,'必须补上时区偏移');
  // ② 真正的垃圾值 → 仍然在建草稿之前拦下
  await editor.open('event');await tick();
  document.querySelector('[data-field="title"]').value='垃圾时间';
  document.querySelector('[data-field="startDate"]').value='2026-13-45';
  document.querySelector('#objpreview').click();await tick();
  assert.equal(store.inbox({workspace:'w',actor:'t'}).length,1,'非法时间不得生成待确认的改动');
  assert.deepEqual(notes.map(([,error])=>error),[true]);
  assert.match(document.querySelector('#detailtitle').textContent,/新建日程/);
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
