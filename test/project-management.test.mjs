import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {createProjectDetail} from '../prototype/project-detail.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {validateData} from '../src/validation.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));

/** 项目管理面板：阶段、材料、任务、计划与里程碑都要真的在界面上，而不是只有计数。 */
const fixture=()=>{
 const today=new Date().toISOString().slice(0,10);
 const item={id:'p1',kind:'project',revision:4,archived:false,data:{
  title:'联合验证',goal:'验证联合方案可行性',stage:'方案',partnerId:'o1',ownerId:'u1',
  startDate:'2026-10-01',dueDate:'2026-12-31',
  stageHistory:[{stage:'接触',at:'2026-09-20T02:00:00.000Z'},{stage:'方案',at:'2026-10-05T02:00:00.000Z'}],
  deliverables:[
   {id:'d1',title:'试点方案定稿',done:false,dueDate:'2020-01-05',ownerId:'u1',status:'doing'},
   {id:'d2',title:'验收材料',done:true,dueDate:'2999-12-31'},
  ],
 }};
 const tasks=[{id:'t1',kind:'task',revision:1,data:{title:'试点方案整理',projectId:'p1',status:'in_progress',ownerId:'u1',dueDate:'2020-01-05',steps:[{id:'s1',title:'a',done:true},{id:'s2',title:'b',done:false}]}}];
 const files=[{id:'a1',kind:'artifact',revision:1,data:{title:'伙伴背景资料',projectId:'p1',path:'notes/partner.md',fileVersion:'v2'}}];
 const entities={o1:{id:'o1',kind:'organization',data:{title:'伙伴 A'}},u1:{id:'u1',kind:'person',data:{title:'张工'}}};
 const send=async(action,payload)=>{
  if(action==='get')return {item:entities[payload.id]??item};
  if(action==='list')return {items:payload.kind==='task'?tasks:payload.kind==='artifact'?files:Object.values(entities).filter(x=>x.kind===payload.kind)};
  throw Error('unexpected '+action);
 };
 return {item,send,today};
};

test('the project dialog is a management panel: stage, materials, tasks and schedule are all present',async()=>{
 const dom=shell(),document=dom.window.document,{send}=fixture();
 const calls=[];
 const detail=createProjectDetail(document,send,{openGraph:()=>{},onEdit:()=>{},onAdvanceStage:(item,stage)=>calls.push(['stage',stage]),onNewTask:id=>calls.push(['task',id]),onLinkMaterial:id=>calls.push(['link',id]),onOpenMaterial:id=>calls.push(['material',id]),onUnlinkMaterial:(id,pid)=>calls.push(['unlink',id,pid])});
 try{
  await detail.open('p1');
  const body=document.querySelector('#detailbody');
  const sections=[...body.querySelectorAll('h3')].map(node=>node.textContent.trim());
  for(const name of ['阶段推进','优先级与计划'])assert(sections.some(text=>text.startsWith(name)),'面板必须有「'+name+'」小节：'+sections.join('、'));
  assert.match(body.querySelector('[data-priority]').textContent,/优先级/, '面板必须显示优先级（与卡片、筛选、排序同一套取值）');
  assert.match(body.querySelector('[data-plan]').textContent,/计划区间|计划日期/, '面板必须显示计划');
  assert(sections.some(text=>text.startsWith('任务 ·')),'任务小节必须显示真实数量');
  assert(sections.some(text=>text.startsWith('材料 ·')),'材料小节必须显示真实数量');
  // 阶段：显示已走过的阶段与时间，并提供下一步推进
  const rail=body.querySelector('[data-phase-rail]');
  assert.match(rail.textContent,/2026-09-20/,'阶段条要显示实际进入时间');
  // 2026-10-14：阶段条每一格改成可点（用户要求"左拉右拉就定了"），
  // 原来那个蓝色「推进到下一阶段」按钮删掉了 —— 同一件事不留两个控件（VI §6）。
  // 断言强度不变：点"下一阶段"那一格，必须真的产生一次 stage 调用。
  const chip=body.querySelector('[data-phase-set="验证"]');
  assert.ok(chip,'方案之后应当是验证，且「验证」这一格要能点');
  chip.click();assert.deepEqual(calls.at(-1),['stage','验证']);
  // 计划与里程碑：逾期要标出来
  assert.match(body.textContent,/2026-10-01 → 2026-12-31/,'计划区间要显示');
  assert.equal(body.querySelector('.chip[data-state="late"]').textContent,'已逾期','逾期交付项必须标出来');
  assert.match(body.querySelector('[data-plan]').textContent,/1 个已逾期/);
  // 任务：显示负责人、截止、状态，可新建
  const taskRow=body.querySelector('[data-task]');
  assert.match(taskRow.textContent,/张工/,'任务行要显示负责人真实姓名');
  assert.match(taskRow.textContent,/试点方案整理/);
  body.querySelector('[data-newtask]').click();assert.deepEqual(calls.at(-1),['task','p1'],'新建任务必须带上项目 ID');
  // 材料：列出材料并可打开 / 取消关联
  const materialRow=body.querySelector('[data-material]');
  assert.match(materialRow.textContent,/伙伴背景资料/);
  assert.match(materialRow.textContent,/notes\/partner.md/);
  body.querySelector('[data-material-open]').click();assert.deepEqual(calls.at(-1),['material','a1']);
  body.querySelector('[data-material-unlink]').click();assert.deepEqual(calls.at(-1),['unlink','a1','p1']);
  body.querySelector('[data-linkmaterial]').click();assert.deepEqual(calls.at(-1),['link','p1']);
  // 目标必须始终在场（含没有交付项的项目）
  assert.match(body.querySelector('#newprojectgoal').textContent,/验证联合方案可行性/);
 }finally{detail.dispose();dom.window.close()}
});

test('a project without deliverables still shows the management panel instead of a dead end',async()=>{
 const dom=shell(),document=dom.window.document;
 const send=async(action,payload)=>action==='get'?{item:{id:'p2',kind:'project',revision:1,data:{title:'新项目',stage:'接触'}}}:{items:[]};
 const detail=createProjectDetail(document,send,{openGraph:()=>{},onEdit:()=>{}});
 try{
  await detail.open('p2');
  const body=document.querySelector('#detailbody');
  assert.match(body.textContent,/还没有交付项/);
  assert.match(body.textContent,/还没有任务/);
  assert.match(body.textContent,/还没有关联材料/);
  assert(body.querySelector('[data-phase-rail]'),'没有交付项也要能看到阶段');
  assert.ok(body.querySelector('[data-phase-set="需求"]'),'没有交付项也要能看到阶段，且每一格都能点');
 }finally{detail.dispose();dom.window.close()}
});

test('stage advance is recorded as a real change with history, and validation rejects made-up stages',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'pm',canWrite:true};
 try{
  const seed=store.draft(ctx,{title:'建项目',changes:[{op:'create',id:'p1',kind:'project',data:{title:'联合验证',stage:'接触'}}]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'k1'});
  const now=new Date().toISOString();
  const item=store.get(ctx,'p1');
  const advance=store.draft(ctx,{title:'推进阶段',changes:[{op:'update',id:'p1',expectedRevision:item.revision,data:{...item.data,stage:'需求',stageHistory:[{stage:'需求',at:now}]}}]});
  const receipt=store.commit(ctx,{batchId:advance.id,revision:1,key:'k2'});
  const after=store.get(ctx,'p1');
  assert.equal(after.data.stage,'需求');
  assert.deepEqual(after.data.stageHistory,[{stage:'需求',at:now}],'阶段推进必须留下真实时间');
  // 推进也能撤销（回执）
  const undo=store.writeUndoDraft(ctx,receipt.key);
  store.commit(ctx,{batchId:undo.id,revision:1,key:'k3'});
  assert.equal(store.get(ctx,'p1').data.stage,'接触','阶段推进应当可以撤销');
  assert.throws(()=>validateData('project',{title:'X',stageHistory:[{stage:'编造阶段',at:now}]}),/未知阶段/);
 }finally{store.close()}
});

test('linking and unlinking a material changes only the link, never the file itself',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'pm',canWrite:true};
 try{
  const seed=store.draft(ctx,{title:'种子',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'联合验证'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'伙伴背景资料',path:'notes/partner.md',fileGrantId:'g',fileVersion:'v1'}},
  ]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'k1'});
  const artifact=store.get(ctx,'a1');
  const link=store.draft(ctx,{title:'关联材料',changes:[{op:'update',id:'a1',expectedRevision:artifact.revision,data:{...artifact.data,projectId:'p1'}}]});
  store.commit(ctx,{batchId:link.id,revision:1,key:'k2'});
  assert.equal(store.get(ctx,'a1').data.projectId,'p1');
  const linked=store.get(ctx,'a1');
  const data={...linked.data};delete data.projectId;
  const unlink=store.draft(ctx,{title:'取消关联',changes:[{op:'update',id:'a1',expectedRevision:linked.revision,data}]});
  store.commit({...ctx},{batchId:unlink.id,revision:1,key:'k3'});
  const after=store.get(ctx,'a1');
  assert.equal(after.data.projectId,undefined,'取消关联后不应再有 projectId');
  assert.equal(after.data.path,'notes/partner.md','文件路径必须原样保留');
  assert.equal(after.data.fileVersion,'v1','版本必须原样保留');
  // 引用方向很重要：链接存在**材料**上（材料 → 项目），所以删材料不会留下悬空引用——这是允许的；
  // 反过来，还有材料/任务指向的项目**不能删**（否则那些记录会指向一个不存在的项目）。
  const relink=store.draft(ctx,{title:'再次关联',changes:[{op:'update',id:'a1',expectedRevision:after.revision,data:{...after.data,projectId:'p1'}}]});
  store.commit(ctx,{batchId:relink.id,revision:1,key:'k4'});
  const linked2=store.get(ctx,'a1');
  assert.deepEqual(store.references(ctx,'p1').map(ref=>ref.id),['a1'],'项目被材料引用，预览必须列出它');
  const removeProject=store.draft(ctx,{title:'删除项目',changes:[{op:'delete',id:'p1',expectedRevision:1}]});
  assert.throws(()=>store.commit(ctx,{batchId:removeProject.id,revision:1,key:'k5'}),/仍被 1 个对象引用/,'还有材料指向的项目不能直接删');
  store.cancelDraft(ctx,removeProject.id,1);
  const removeMaterial=store.draft(ctx,{title:'删除材料',changes:[{op:'delete',id:'a1',expectedRevision:linked2.revision}]});
  store.commit(ctx,{batchId:removeMaterial.id,revision:1,key:'k6'});
  assert.equal(store.get(ctx,'a1'),null,'材料本身可以删除（链接随它一起消失，不会留下悬空引用）');
 }finally{store.close()}
});
