import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {mountV7} from '../prototype/v7-controller.mjs';
import {createRecordDetail} from '../prototype/record-detail.mjs';

// 体检 A4：项目面板早就能「关联已有材料」，任务详情没有入口；材料详情也不显示它支撑哪些任务。
// 这里锁住三件事：任务详情有关联入口且追加 taskIds（不覆盖）、材料详情显示"关联任务：X/Y"、
// 关联动作走的是同一批草稿（不是直接写业务数据）。

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(times=10)=>{for(let i=0;i<times;i+=1)await tick()};
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(url,options={})=>route.fetch(new Request('http://localhost'+url,{method:options.method??'GET',headers:options.headers,body:options.body}));
}

test('the task detail links an existing material by appending taskIds through one draft batch',async()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const seed=store.draft(ctx,{title:'seed',changes:[
  {op:'create',id:'t-1',kind:'task',data:{title:'跟进试点'}},
  {op:'create',id:'t-2',kind:'task',data:{title:'整理材料'}},
  {op:'create',id:'a-1',kind:'artifact',data:{title:'会议纪要',path:'meetings/a.md',taskIds:['t-1']}},
  {op:'create',id:'a-2',kind:'artifact',data:{title:'录音原件',path:'meetings/a.m4a',taskIds:['t-2']}},
 ]});
 store.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
 const dom=shell(),document=dom.window.document,notices=[];
 const controller=await mountV7(document,{workspace:'w',fetch:bridge(store),notify:(text,error)=>notices.push({text,error}),confirm:()=>true});
 try{
  controller.navigation.show('tasks');await settle();
  const card=[...document.querySelectorAll('#tasksbody [data-task]')].find(node=>node.textContent.includes('跟进试点'));
  assert(card,'任务列表必须先渲染出任务卡片');
  card.click();await settle();
  assert.equal(document.querySelector('#detailtype').textContent,'任务');
  const linkButton=document.querySelector('#tasklinkmaterial');
  assert(linkButton,'任务详情必须有「关联已有材料」入口');
  assert.match(document.querySelector('#detailbody [data-refs-line]').textContent,/关联材料：1 份/,'任务详情要如实显示有几份材料支撑它');
  linkButton.click();await settle();
  assert.equal(document.querySelector('#tasklinkbody [data-tasklink="a-1"]'),null,'已经挂到本任务的资料不该再出现在候选里');
  const candidate=document.querySelector('#tasklinkbody [data-tasklink="a-2"]');
  assert(candidate,'挂到别的任务的资料要出现在候选里（多对多，一份材料支撑多个任务）');
  candidate.click();await settle();
  // 用户自己点的操作：直接生效（不再要求自己给自己点同意），但必须留记录、可撤销。
  assert.deepEqual(store.get(ctx,'a-2').data.taskIds,['t-2','t-1'],'追加而不是覆盖：原有任务必须保留');
  assert.equal(store.inbox(ctx,{status:'draft'}).length,0,'自己的操作不该再堆进待你决定的改动');
  assert(store.inbox(ctx,{status:'committed'}).length>=1,'但要留下可追溯的记录');
  const bar=document.querySelector('#undobar');
  assert(bar&&!bar.hidden,'必须给「已保存 · 撤销」');
  assert.deepEqual(notices.filter(item=>item.error).map(item=>item.text),[],'关联过程不得报错');
 }finally{controller.dispose();store.close();dom.window.close()}
});

test('the material detail states how many linked tasks are done, and never invents names',async()=>{
 const dom=shell(),document=dom.window.document;
 const item={id:'a-1',kind:'artifact',revision:1,archived:false,data:{title:'会议纪要',content:'# 纪要',taskIds:['t-1','t-2','gone']}};
 const tasks={ 't-1':{id:'t-1',kind:'task',revision:1,archived:false,data:{title:'跟进试点',status:'done'}},
                't-2':{id:'t-2',kind:'task',revision:1,archived:false,data:{title:'整理材料',status:'in_progress'}} };
 const send=async(action,data={})=>{
  if(action==='get')return {item:data.id==='a-1'?item:(tasks[data.id]??null)};
  if(action==='artifact_state')return {status:'current',version:'v1'};
  if(action==='knowledge_status')return {available:false,reason:'未接入'};
  if(action==='knowledge_bases')return {items:[]};
  if(action==='file_grants')return {items:[{id:'g1',label:'会议',read:true,write:false}]};
  throw Error(action);
 };
 const detail=createRecordDetail(document,send,{notify:()=>{},openEditFile:()=>{}});
 try{
  await detail.open('a-1');await settle();
  const line=document.querySelector('#detailbody [data-linktasks]');
  assert(line,'材料详情必须显示关联任务');
  assert.match(line.textContent,/关联任务：1\/3 已完成/,'X/Y = 已完成/全部，与交付项↔任务的写法一致');
  assert.match(line.textContent,/跟进试点/);
  assert.match(line.textContent,/整理材料/);
  assert.match(line.textContent,/任务 gone（名称读不到）/,'查不到的任务必须如实说读不到，不能编名字');
 }finally{detail.dispose();dom.window.close()}
});

test('a material with no task link says so instead of showing an empty count',async()=>{
 const dom=shell(),document=dom.window.document;
 const item={id:'a-2',kind:'artifact',revision:1,archived:false,data:{title:'会议纪要'}};
 const send=async(action,data={})=>{
  if(action==='get')return {item};
  if(action==='artifact_state')return {status:'current',version:'v1'};
  if(action==='knowledge_status')return {available:false,reason:'未接入'};
  if(action==='knowledge_bases')return {items:[]};
  throw Error(action);
 };
 const detail=createRecordDetail(document,send,{notify:()=>{}});
 try{
  await detail.open('a-2');await settle();
  assert.match(document.querySelector('#detailbody [data-linktasks]').textContent,/关联任务：未关联/,'没关联就写"未关联"');
 }finally{detail.dispose();dom.window.close()}
});
