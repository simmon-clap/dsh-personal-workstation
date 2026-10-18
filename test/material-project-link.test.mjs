import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createBatchFlow} from '../prototype/batch.mjs';
import {createInbox,batchLink} from '../prototype/inbox.mjs';
import {linkBatchChanges,AUTO_LINK_SOURCE} from '../src/batch-link.mjs';

// 体检 A2：同一批里"新建项目 + 新建材料"时材料没有自动指向该项目，用户只能事后单独补一批
// （真实数据：「会议纪要归档 · 示例科技」的材料 projectId 是空的，随后又确认了一批「把会议资料挂到示例科技项目上」）。
// 这里锁住四件事：恰好 1 个同批新建项目才自动关联；0 个与 ≥2 个都不猜；材料自己带 projectId 绝不覆盖；
// 自动关联在预览与收件箱卡片里看得见，并能在同一批草稿内改回未归属 / 换项目（不绕过批次）。

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(times=12)=>{for(let i=0;i<times;i+=1)await tick()};
const ctxOf=()=>({workspace:'w',actor:'t',canWrite:true});
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const materialOf=(batch,id)=>batch.changes.find(change=>change.id===id);

test('exactly one same-batch project auto-links the materials created with it, with an honest source',()=>{
 const store=new WorkstationStore(':memory:'),ctx=ctxOf();
 try{
  const batch=store.draft(ctx,{title:'会议纪要归档 · 示例科技',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'示例科技 · 3D 存算一体芯片技术适配与合作研判'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要 · 示例科技 3D 存算一体芯片路演',path:'meetings/a.md',content:'纪要原文'}},
  ]});
  const material=materialOf(batch,'a1');
  assert.equal(material.data.projectId,'p1','同批新建的材料必须自动指向同批新建的项目');
  assert.equal(material.sources.projectId,AUTO_LINK_SOURCE,'自动补的归属必须如实标注来源');
  assert.match(material.sources.projectId,/自动关联/,'来源说明要写明是机器自动关联，不写成"用户指定"');
  const preview=store.preview(ctx,batch.id);
  assert.equal(preview.diff.find(entry=>entry.id==='a1').sources.projectId,AUTO_LINK_SOURCE,'预览里必须看得见它是自动关联的');
  store.commit(ctx,{batchId:batch.id,revision:1,key:'k'});
  assert.equal(store.get(ctx,'a1').data.projectId,'p1','提交后材料真的挂在项目上，不需要用户再补一批');
 }finally{store.close()}
});

test('with no same-batch project the draft is left exactly as written',()=>{
 const store=new WorkstationStore(':memory:'),ctx=ctxOf();
 try{
  const changes=[
   {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',path:'meetings/a.md',content:'原文'}},
   {op:'create',id:'t1',kind:'task',data:{title:'跟进试点'}},
  ];
  const batch=store.draft(ctx,{title:'没有新建项目',changes});
  assert.deepEqual(batch.changes.map(change=>change.data),changes.map(change=>change.data),'没有同批新建项目时一个字段都不许改');
  assert.equal(Object.hasOwn(batch.changes[0].data,'projectId'),false);
  assert.equal(batch.changes[0].sources,undefined,'没有改动就不该凭空多出来源标注');
 }finally{store.close()}
});

test('two same-batch projects are never guessed',()=>{
 const store=new WorkstationStore(':memory:'),ctx=ctxOf();
 try{
  const batch=store.draft(ctx,{title:'一批两个项目',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'项目甲'}},
   {op:'create',id:'p2',kind:'project',data:{title:'项目乙'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要'}},
  ]});
  assert.equal(Object.hasOwn(materialOf(batch,'a1').data,'projectId'),false,'指向哪个项目是用户的决定，服务端不猜');
  assert.equal(materialOf(batch,'a1').sources,undefined);
 }finally{store.close()}
});

test('a material that already carries a projectId is never overwritten',()=>{
 const store=new WorkstationStore(':memory:'),ctx=ctxOf();
 try{
  const seed=store.draft(ctx,{title:'seed',changes:[{op:'create',id:'p0',kind:'project',data:{title:'既有项目'}}]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  const batch=store.draft(ctx,{title:'已有归属的材料',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'同批新建的项目'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',projectId:'p0'},sources:{projectId:'Agent 明确指定'}},
  ]});
  const material=materialOf(batch,'a1');
  assert.equal(material.data.projectId,'p0','材料自己带的归属绝不覆盖');
  assert.equal(material.sources.projectId,'Agent 明确指定','已有的来源说明不得被机器改写');
 }finally{store.close()}
});

test('linkBatchChanges only fills blanks: it is the single rule behind the four cases above',()=>{
 const missing=linkBatchChanges([{op:'create',id:'p1',kind:'project',data:{title:'P'}},{op:'create',id:'a1',kind:'artifact',data:{title:'A'}}]);
 assert.deepEqual(missing.linked,['a1']);
 assert.equal(missing.changes[1].data.projectId,'p1');
 assert.equal(missing.changes[0].data.projectId,undefined,'项目自己不挂项目');
 const two=linkBatchChanges([{op:'create',id:'p1',kind:'project',data:{title:'P'}},{op:'create',id:'p2',kind:'project',data:{title:'Q'}},{op:'create',id:'a1',kind:'artifact',data:{title:'A'}}]);
 assert.deepEqual(two.linked,[]);
 assert.equal(two.changes[2].data.projectId,undefined);
 const updates=linkBatchChanges([{op:'create',id:'p1',kind:'project',data:{title:'P'}},{op:'update',id:'a1',expectedRevision:1,data:{title:'A'}}]);
 assert.deepEqual(updates.linked,[],'只处理同批新建的材料，不改既有记录的归属');
 // 范围边界：自动关联只覆盖"材料"=资料记录（artifact）。议题/任务的归属要显式写，机器不替用户决定。
 const topic=linkBatchChanges([{op:'create',id:'p1',kind:'project',data:{title:'P'}},{op:'create',id:'t1',kind:'topic',data:{title:'T'}}]);
 assert.deepEqual(topic.linked,[],'研究议题不自动关联：它的归属由 Agent/界面显式写 projectId');
});

test('the preview says 将归属：X 项目, and the auto link can be undone inside the same draft',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),ctx=ctxOf(),notes=[];
 const flow=createBatchFlow(document,send,{notify:(text,error)=>notes.push([text,error]),confirm:()=>true});
 try{
  const draft=await send('draft',{title:'会议纪要归档 · 示例科技',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'示例科技'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',path:'meetings/a.md'}},
  ]});
  await flow.open(draft.id);await tick();await tick();
  const linkBlock=document.querySelector('#detailbody [data-linkblock="1"]');
  assert(linkBlock,'预览必须显示归属核对');
  assert.match(linkBlock.textContent,/将归属：示例科技（本批新建项目自动关联）/,'预览要写明"将归属：X 项目"，并说明是自动关联的');
  // 不认可自动补的归属 → 在同一批草稿里改回去（不是提交后再补一批）。
  const unlink=document.querySelector('#detailbody [data-unlink="1"]');
  assert(unlink,'自动补的归属必须能在这一批里撤销');
  unlink.click();await settle();
  assert.match(document.querySelector('#detailbody [data-linkblock="1"]').textContent,/归属：未归属/,'撤销后如实写未归属（'+JSON.stringify(notes)+'）');
  const revised=store.batch(ctx,draft.id);
  assert.equal(revised.revision,2,'改归属走的是同一批待确认的改动的新修订');
  assert.equal(Object.hasOwn(revised.changes.find(change=>change.id==='a1').data,'projectId'),false);
  assert.equal(revised.changes.find(change=>change.id==='a1').sources?.projectId,undefined,'撤销后不许留下过期的来源标注');
  assert.equal(store.get(ctx,'a1'),null,'待确认的改动阶段不得写入业务数据');
  // 再一键指定回同批新建的项目。
  const pick=document.querySelector('#detailbody [data-linkpick="1"]');
  assert(pick,'未归属时必须给出一键指定入口');
  pick.value='p1';
  document.querySelector('#detailbody [data-link="1"]').click();await settle();
  const after=store.batch(ctx,draft.id);
  assert.equal(after.changes.find(change=>change.id==='a1').data.projectId,'p1');
  assert.match(document.querySelector('#detailbody [data-linkblock="1"]').textContent,/归属：示例科技（本批新建）/,'用户指定的归属不是"自动关联"');
  document.querySelector('#batchCommit').click();await settle();
  assert.equal(store.get(ctx,'a1').data.projectId,'p1','提交后材料真的挂在项目上');
  assert.deepEqual(notes.filter(([,error])=>error),[]);
 }finally{flow.dispose();store.close();dom.window.close()}
});

test('the inbox card shows 归属：X 项目 / 未归属 and can assign unassigned materials in one click',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),ctx=ctxOf(),notes=[];
 try{
  const seed=await send('draft',{title:'seed',changes:[{op:'create',id:'p0',kind:'project',data:{title:'示例科技'}}]});
  await send('commit',{id:seed.id,revision:1,key:'seed'});
  const draft=await send('draft',{title:'一批两个项目',changes:[
   {op:'create',id:'q1',kind:'project',data:{title:'项目甲'}},
   {op:'create',id:'q2',kind:'project',data:{title:'项目乙'}},
   {op:'create',id:'a2',kind:'artifact',data:{title:'会议纪要',path:'meetings/b.md'}},
  ]});
  const root=document.createElement('div');document.body.append(root);
  const inbox=createInbox(document,send,{open:async()=>{},draft:async()=>{}},{notify:(text,error)=>notes.push([text,error]),projects:[{id:'p0',title:'示例科技'}]});
  try{
   await inbox.render(root);await settle();
   const linkText=root.querySelector('[data-linktext]');
   assert(linkText,'收件箱卡片必须显示归属');
   assert.match(linkText.textContent,/归属：未归属/,'材料没归属就如实写未归属，不假装已归属');
   const pick=root.querySelector('[data-linkpick]');
   assert(pick,'未归属时必须给出一键指定入口');
   pick.value='p0';
   root.querySelector('[data-linkassign]').click();
   await settle();
   const revised=store.batch(ctx,draft.id);
   assert.equal(revised.revision,2,'一键指定走的是同一批待确认的改动的修订');
   assert.equal(revised.changes.find(change=>change.id==='a2').data.projectId,'p0');
   assert.equal(revised.changes.find(change=>change.id==='a2').sources.projectId,'用户在收件箱指定','来源如实写成用户在收件箱指定');
   assert.equal(store.get(ctx,'a2'),null,'指定归属不得直接写入业务数据，仍要用户确认提交');
   assert.match(root.querySelector('[data-linktext]').textContent,/归属：示例科技/,'指定后卡片显示真实归属');
   assert.equal(root.querySelector('[data-linkassign]'),null,'都归属了就不该再显示指定入口');
   assert.deepEqual(notes.filter(([,error])=>error),[]);
  }finally{inbox.dispose()}
 }finally{store.close();dom.window.close()}
});

test('batchLink never invents a project name and stays quiet for records that cannot belong to one',()=>{
 assert.equal(batchLink({changes:[{op:'create',kind:'artifact',data:{title:'纪要'}}]},[]).text,'归属：未归属');
 assert.equal(batchLink({changes:[{op:'create',kind:'artifact',data:{title:'纪要',projectId:'p1'}}]},[{id:'p1',title:'示例科技'}]).text,'归属：示例科技');
 assert.equal(batchLink({changes:[{op:'create',id:'p1',kind:'project',data:{title:'示例科技'}},{op:'create',id:'a1',kind:'artifact',data:{title:'纪要',projectId:'p1'}}]},[]).text,'归属：示例科技（本批新建）','同批新建的项目名取自这批变更，卡片不显示裸 id');
 assert.equal(batchLink({changes:[{op:'create',kind:'artifact',data:{title:'纪要',projectId:'p9'}}]},[]).text,'归属：项目 p9','查不到名字就显示 id，不编一个项目名');
 assert.equal(batchLink({changes:[{op:'create',kind:'project',data:{title:'P'}}]},[]),null,'项目自己不需要显示归属行');
 assert.equal(batchLink({changes:[{op:'create',kind:'artifact',data:{title:'A',projectId:'p1'}},{op:'create',kind:'topic',data:{title:'T'}}]},[{id:'p1',title:'示例科技'}]).text,'归属：示例科技','议题不在归属行里，不给它编归属');
});
