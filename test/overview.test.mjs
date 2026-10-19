import {test} from 'node:test';import assert from 'node:assert/strict';import {WorkstationStore} from '../src/store.mjs';import {overview} from '../src/overview.mjs';
test('overview uses exact deliverables and distinguishes business from execution',()=>{const s=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};try{const b=s.draft(ctx,{title:'setup',changes:[{op:'create',id:'p',kind:'project',data:{title:'P',deliverables:[{id:'a',title:'A',done:true},{id:'b',title:'B',done:false}]}},{op:'create',id:'q',kind:'project',data:{title:'Q'}},{op:'create',id:'t',kind:'task',data:{title:'T',projectId:'p',status:'in_progress'}}]});s.commit(ctx,{batchId:b.id,revision:1,key:'setup'});const o=overview(s,ctx);assert.equal(o.completedDeliveries,1);assert.equal(o.totalDeliveries,2);assert.equal(o.projects.find(p=>p.id==='q').percent,null);assert.equal(o.projects.find(p=>p.id==='p').percent,50);assert.equal(o.pendingBatches,0);assert.equal(o.taskStatus.in_progress,1);assert.equal(o.execution.connected,false);assert.equal(overview(s,{...ctx,workspace:'other'}).projectCount,2,'首页统计跨工作区一致（全局数据）');}finally{s.close()}});
test('the overview payload exposes 待整理 separately from pending batches',async()=>{
 const {WorkstationStore}=await import('../src/store.mjs');
 const {overview}=await import('../src/overview.mjs');
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 // 项目先单独一批建好：同批新建「1 个项目 + 资料」会把资料自动归属到该项目（体检 A2），
 // 那样这批就不再有"未归属资料"，本用例要测的待整理计数会被改没。
 const project=store.draft(ctx,{title:'seed-project',changes:[
  {op:'create',id:'p1',kind:'project',data:{title:'项目'}},
 ]});
 store.commit(ctx,{batchId:project.id,revision:1,key:'kp'});
 const batch=store.draft(ctx,{title:'seed',changes:[
  {op:'create',id:'a1',kind:'artifact',data:{title:'未归属资料'}},
  {op:'create',id:'a2',kind:'artifact',data:{title:'已归属资料',projectId:'p1'}},
  {op:'create',id:'t1',kind:'topic',data:{title:'未归属议题'}},
 ]});
 store.commit(ctx,{batchId:batch.id,revision:1,key:'k'});
 try{
  const result=overview(store,ctx);
  assert.deepEqual(result.unorganized,{materials:1,topics:1,total:2});
  assert.equal(result.pendingBatches,0,'待整理与待确认是两件事');
  const pending=store.draft(ctx,{title:'待确认的改动',changes:[{op:'create',id:'x',kind:'topic',data:{title:'X'}}]});
  const withDraft=overview(store,ctx);
  assert.equal(withDraft.pendingBatches,1);
  assert.equal(withDraft.unorganized.total,2,'生成待确认的改动不应改变待整理的判定');
  void pending;
 }finally{store.close()}
});
