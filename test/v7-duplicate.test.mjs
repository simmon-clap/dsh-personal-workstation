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
const seed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};const batch=store.draft(ctx,{title:'seed',changes:[{op:'create',id:'p1',kind:'project',data:{title:'联合验证',goal:'原目标',tags:['保留']}}]});store.commit(ctx,{batchId:batch.id,revision:1,key:'seed'})};

test('creating a same-named project warns first instead of silently making a duplicate',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:()=>{}});
 try{
  await editor.open('project');await tick();
  document.querySelector('[data-field="title"]').value='联合验证';
  document.querySelector('#objpreview').click();await tick();await tick();
  assert(document.querySelector('[data-duplicate]'),'同名新建必须先给出匹配提示');
  assert.match(document.querySelector('[data-duplicate]').textContent,/不会仅凭名称自动合并/);
  assert.equal(store.inbox({workspace:'w',actor:'t'}).filter(item=>item.title==='新建项目').length,0,'提示阶段不得生成待确认的改动');
  assert.match(document.querySelector('#detailtitle').textContent,/新建项目/,'提示留在当前对话框，不跳转');
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
test('confirming the duplicate hint creates the second project, and the shortcut edits the existing one',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:()=>{}});
 try{
  await editor.open('project');await tick();
  document.querySelector('[data-field="title"]').value='联合验证';
  document.querySelector('#objpreview').click();await tick();await tick();
  document.querySelector('[data-duplicate-open="p1"]').click();await tick();await tick();
  assert.equal(document.querySelector('[data-field="goal"]').value,'原目标','改为编辑必须载入完整对象，而不是搜索摘要');
  document.querySelector('[data-field="goal"]').value='新目标';
  // 用户自己改的内容：保存即生效（不再弹确认框），并留一条可撤销的记录。
  document.querySelector('#objpreview').click();for(let i=0;i<4;i++)await tick();
  const saved=store.get({workspace:'w',actor:'t'},'p1');
  assert.equal(saved.data.goal,'新目标');assert.deepEqual(saved.data.tags,['保留'],'未在表单中的字段不得丢失');
  assert.equal(store.list({workspace:'w',actor:'t'}).length,1,'编辑既有对象不得新建副本');

  await editor.open('project');await tick();
  document.querySelector('[data-field="title"]').value='联合验证';
  document.querySelector('#objpreview').click();await tick();await tick();
  // 明知同名还继续：直接建（这是你明确的选择），不再多问一遍。
  document.querySelector('#objduplicate').click();for(let i=0;i<4;i++)await tick();
  assert.equal(store.list({workspace:'w',actor:'t'}).length,2,'明知同名仍继续时允许建立新对象');
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
test('empty name and blank checklist entries are rejected before any draft exists',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:(text,error)=>notes.push([text,error])});
 try{
  await editor.open('project');await tick();
  document.querySelector('#objpreview').click();await tick();
  assert.equal(store.inbox({workspace:'w',actor:'t'}).length,0,'空名称不得生成待确认的改动');
  assert.equal(notes.at(-1)[1],true);
  document.querySelector('[data-field="title"]').value='新项目';
  document.querySelector('#objadditem').click();
  document.querySelector('#objpreview').click();await tick();
  assert.equal(store.inbox({workspace:'w',actor:'t'}).length,0,'空条目名称不得生成待确认的改动');
  assert.match(notes.at(-1)[0],/条目名称/);
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
