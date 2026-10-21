import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {mountSpace} from '../prototype/space-view-v5.mjs';

/** A3 / PRD CV-08：点画布上的 AI 虚线，出来的是**画布内操作条**（看依据 / 同意 / 不同意 / 稍后），
 *  不是强制弹窗；同意/不同意走与收件箱同一条写入链路，稍后不改任何数据。 */
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:5599/personal-workstation'});
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const seed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};const b=store.draft(ctx,{title:'seed',changes:[
 {op:'create',id:'a1',kind:'artifact',data:{title:'共享资料'}},
 {op:'create',id:'p2',kind:'project',data:{title:'项目二'}},
 {op:'create',id:'r1',kind:'relation',data:{title:'可能复用',from:'a1',to:'p2',status:'suggested',evidence:'两处引用同一份资料'}},
]});store.commit(ctx,{batchId:b.id,revision:1,key:'seed'})};
const pointer=(dom,document,target,type)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:0,clientY:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function mount(){
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const drafts=[],notes=[];
 const view=mountSpace(document,{send,batch:{draft:async(title,changes)=>{drafts.push({title,changes})}},open:()=>{},notify:(text,error)=>notes.push([text,error]),projects:[{id:'p2',title:'项目二'}],key:()=>'layout:test'});
 await view.load();
 const scope=document.querySelector('#scopefilter');scope.value='all';scope.onchange();
 await tick();
 return {store,dom,document,view,drafts,notes};
}
const edgeEl=document=>document.querySelector('#spaceSvg [data-edge="r1"]');

test('点 AI 虚线先出画布内操作条：四个动作齐全，默认不弹窗',async()=>{
 const {store,dom,document,view}=await mount();
 try{
  const edge=edgeEl(document);
  assert(edge,'待确认的关联应画在画布上');
  pointer(dom,document,edge,'pointerdown');pointer(dom,document,edge,'pointerup');
  const bar=document.querySelector('#canvasactionbar');
  assert(bar,'点虚线应出现画布内操作条');
  assert.deepEqual([...bar.querySelectorAll('[data-edge-action]')].map(node=>node.dataset.edgeAction),['basis','accept','reject','later']);
  assert.match(bar.textContent,/待确认建议/);
  assert.equal(document.querySelector('#veil').classList.contains('open'),false,'操作条不是强制弹窗');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('操作条「同意」走与收件箱同一条写入链路（带两端版本依据）',async()=>{
 const {store,dom,document,view,drafts}=await mount();
 try{
  const edge=edgeEl(document);
  pointer(dom,document,edge,'pointerdown');pointer(dom,document,edge,'pointerup');
  document.querySelector('#canvasactionbar [data-edge-action="accept"]').click();
  for(let i=0;i<6;i+=1)await tick();
  assert.equal(drafts.length,1,'同意必须生成一条待确认的关系改动');
  assert.equal(drafts[0].changes[0].data.status,'confirmed');
  assert.deepEqual(drafts[0].changes[0].data.basis,['a1@1','p2@1'],'确认时记录两端当前版本（之后变了要标待复核）');
  assert.equal(store.get({workspace:'w',actor:'t'},'r1').data.status,'suggested','同意只生成改动，不会绕过收件箱直接改库');
  assert.equal(document.querySelector('#canvasactionbar'),null,'操作后收起');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('操作条「不同意」记为已忽略；「稍后」只收起、不写任何数据',async()=>{
 const {store,dom,document,view,drafts}=await mount();
 try{
  pointer(dom,document,edgeEl(document),'pointerdown');pointer(dom,document,edgeEl(document),'pointerup');
  document.querySelector('#canvasactionbar [data-edge-action="later"]').click();
  assert.equal(document.querySelector('#canvasactionbar'),null,'稍后收起来');
  assert.equal(drafts.length,0,'稍后不生成改动');
  pointer(dom,document,edgeEl(document),'pointerdown');pointer(dom,document,edgeEl(document),'pointerup');
  document.querySelector('#canvasactionbar [data-edge-action="reject"]').click();
  for(let i=0;i<6;i+=1)await tick();
  assert.equal(drafts.length,1);
  assert.equal(drafts[0].changes[0].data.status,'rejected');
 }finally{view.dispose();store.close();dom.window.close()}
});

test('操作条「看依据」打开同一份关联证据（不是另造一套说明）',async()=>{
 const {store,dom,document,view}=await mount();
 try{
  pointer(dom,document,edgeEl(document),'pointerdown');pointer(dom,document,edgeEl(document),'pointerup');
  document.querySelector('#canvasactionbar [data-edge-action="basis"]').click();
  for(let i=0;i<4;i+=1)await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'可能复用');
  assert.match(document.querySelector('#detailbody').textContent,/两处引用同一份资料/);
  assert.equal(document.querySelector('#canvasactionbar'),null);
 }finally{view.dispose();store.close();dom.window.close()}
});

test('「AI 建议」范围一次只显示一条待确认，并如实写出共几条',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const ctx={workspace:'w',actor:'t',canWrite:true};
 const b=store.draft(ctx,{title:'seed2',changes:[
  {op:'create',id:'a1',kind:'artifact',data:{title:'资料'}},
  {op:'create',id:'p2',kind:'project',data:{title:'项目二'}},
  {op:'create',id:'p3',kind:'project',data:{title:'项目三'}},
  {op:'create',id:'r1',kind:'relation',data:{title:'候选一',from:'a1',to:'p2',status:'suggested',evidence:'依据一'}},
  {op:'create',id:'r2',kind:'relation',data:{title:'候选二',from:'a1',to:'p3',status:'suggested',evidence:'依据二'}},
 ]});
 store.commit(ctx,{batchId:b.id,revision:1,key:'seed2'});
 const view=mountSpace(document,{send,batch:{draft:async()=>{}},open:()=>{},notify:()=>{},projects:[{id:'p2',title:'项目二'},{id:'p3',title:'项目三'}],key:()=>'layout:test'});
 try{
  await view.load();
  const scope=document.querySelector('#scopefilter');scope.value='suggestions';scope.onchange();
  const svg=document.querySelector('#spaceSvg');
  assert.equal(svg.querySelectorAll('[data-edge]').length,1,'一次只显示一条待确认');
  assert.equal(svg.querySelectorAll('[data-node]').length,2,'只显示这一条候选两端的对象');
  assert.equal(svg.querySelector('[data-edge]').dataset.edge,'r1','按 id 稳定排序，第一条不跳来跳去');
  assert.match(document.querySelector('#graphstatus').textContent,/待确认 2 条，当前看第 1 条/,'要如实写出共几条、现在看第几条');
  // 点这条虚线仍然出操作条（一次一条 + 画布内处理，同一条链路）
  pointer(dom,document,svg.querySelector('[data-edge="r1"]'),'pointerdown');pointer(dom,document,svg.querySelector('[data-edge="r1"]'),'pointerup');
  assert(document.querySelector('#canvasactionbar'),'当前这一条可直接在画布上处理');
 }finally{view.dispose();store.close();dom.window.close()}
});
