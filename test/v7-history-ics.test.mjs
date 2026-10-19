import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createTaskDetail} from '../prototype/task-detail.mjs';
import {createRecordDetail} from '../prototype/record-detail.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
function bridge(store,executions){
 const route=browserRoute({store,executions,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('task detail reads the real execution ledger instead of inventing runs',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,executions=new ExecutionStore(store),send=bridge(store,executions);
 const ctx={workspace:'w',actor:'t',canWrite:true};const b=store.draft(ctx,{title:'任务',changes:[{op:'create',id:'t',kind:'task',data:{title:'真实任务',status:'in_progress',steps:[{id:'s',title:'步骤',done:false}]}}]});store.commit(ctx,{batchId:b.id,revision:1,key:'seed'});
 const detail=createTaskDetail(document,send,{openProject:()=>{},onEdit:()=>{}});
 try{
  await detail.open('t');await tick();
  assert(document.querySelector('#taskhistory'),'任务详情应提供执行历史入口');
  document.querySelector('#taskhistory').click();for(let i=0;i<3;i++)await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'任务执行历史');
  assert.match(document.querySelector('#detailbody').textContent,/暂无执行记录/,'没有执行记录时不得编造运行');
  assert.match(document.querySelector('#detailbody').textContent,/执行状态与业务完成状态独立/);
  const reserved=executions.reserve(ctx,{taskId:'t',taskRevision:1,key:'run-1'});executions.started(ctx,reserved.item.id,1,'session-1');
  await detail.open('t');await tick();document.querySelector('#taskhistory').click();for(let i=0;i<3;i++)await tick();
  assert.match(document.querySelector('#detailbody').textContent,/运行中/);
  assert.match(document.querySelector('#detailbody').textContent,/session-1/);
  assert.match(document.querySelector('#detailbody').textContent,/任务版本 1/);
 }finally{detail.dispose();store.close();dom.window.close()}
});
test('event detail exports the saved schedule as ICS and reports failures',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const ctx={workspace:'w',actor:'t',canWrite:true};const b=store.draft(ctx,{title:'日程',changes:[{op:'create',id:'e',kind:'event',data:{title:'会议',startDate:'2026-03-02T09:00:00+08:00',endDate:'2026-03-02T10:00:00+08:00'}}]});store.commit(ctx,{batchId:b.id,revision:1,key:'seed'});
 const downloads=[];dom.window.URL.createObjectURL=()=>'blob:test';dom.window.URL.revokeObjectURL=()=>{};
 dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,download:this.download})};
 const detail=createRecordDetail(document,send,{notify:(text,error)=>notes.push([text,error])});
 try{
  await detail.open('e');await tick();
  const button=document.querySelector('#eventics');assert(button,'日程详情应提供 ICS 导出');
  button.click();for(let i=0;i<4;i++)await tick();
  assert.equal(downloads.length,1,'导出应触发一次下载');
  assert.equal(downloads[0].download,'workstation-calendar.ics');
  const file=await send('calendar_export',{ids:['e']});
  assert.match(file.content,/DTSTART:20260302T010000Z/,'导出内容应来自长期保存日程');
  await assert.rejects(()=>detail.open('missing'),/不存在|不可用|归档/,'不存在的记录必须报错而不是渲染空详情');
  assert.deepEqual(notes,[]);
 }finally{detail.dispose();store.close();dom.window.close()}
});
