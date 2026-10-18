import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateData} from '../src/validation.mjs';
import {WorkstationStore} from '../src/store.mjs';

// 体检 A4：`artifact.taskId` 以前被校验直接拒绝（"未知或受保护字段"），材料在数据层就挂不到任务。
// 用户明确"肯定是多对多"：一份会议纪要常同时支撑多个任务，所以落地为 `taskIds`（非空文本数组）。
// 这里锁住字段形状与"多对多"两条；指向的任务是否存在/归档由 store 的引用校验在提交时硬拦。

test('an artifact can carry taskIds: 多对多, and the list survives commit',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 try{
  assert.doesNotThrow(()=>validateData('artifact',{title:'会议纪要',taskIds:['t-1','t-2']}),'材料必须允许挂多个任务');
  const batch=store.draft(ctx,{title:'会议纪要归档',changes:[
   {op:'create',id:'t-1',kind:'task',data:{title:'跟进试点'}},
   {op:'create',id:'t-2',kind:'task',data:{title:'整理材料'}},
   {op:'create',id:'a-1',kind:'artifact',data:{title:'会议纪要',path:'meetings/a.md',taskIds:['t-1','t-2']}},
  ]});
  const preview=store.preview(ctx,batch.id);
  assert.deepEqual(preview.validationErrors,[],'taskIds 不得再被当成未知字段：'+JSON.stringify(preview.validationErrors));
  store.commit(ctx,{batchId:batch.id,revision:1,key:'k'});
  assert.deepEqual(store.get(ctx,'a-1').data.taskIds,['t-1','t-2'],'多对多的关联必须真的写进工作台');
 }finally{store.close()}
});

test('malformed taskIds are rejected and named in plain language',()=>{
 // 空数组与 dependsOn/tags 同一套既有规则：[] 表示"没有关联"，允许；条目本身必须是非空文本。
 assert.doesNotThrow(()=>validateData('artifact',{title:'A',taskIds:[]}));
 const cases=[
  [{title:'A',taskIds:'t-1'},/taskIds必须为非空文本数组/],
  [{title:'A',taskIds:['']},/taskIds必须为非空文本数组/],
  [{title:'A',taskIds:['  ']},/taskIds必须为非空文本数组/],
  [{title:'A',taskIds:[1]},/taskIds必须为非空文本数组/],
  [{title:'A',taskIds:{'0':'t-1'}},/taskIds必须为非空文本数组/],
 ];
 for(const [data,expected] of cases){
  assert.throws(()=>validateData('artifact',data),expected,'非法 taskIds 必须被拒绝：'+JSON.stringify(data.taskIds));
 }
});

test('a draft with a malformed taskIds list is flagged in the preview instead of silently written',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 try{
  const batch=store.draft(ctx,{title:'坏关联',changes:[{op:'create',id:'a-1',kind:'artifact',data:{title:'纪要',taskIds:['']}}]});
  const errors=store.preview(ctx,batch.id).validationErrors;
  assert.equal(errors.length,1,'预览必须先把非法字段挡住');
  assert.match(errors[0].message,/taskIds必须为非空文本数组/);
  assert.throws(()=>store.commit(ctx,{batchId:batch.id,revision:1,key:'k'}),/taskIds/,'提交仍要硬拦一次');
 }finally{store.close()}
});

test('every taskIds entry must point at an existing, unarchived task in the same workspace',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const w={workspace:'w',actor:'t',canWrite:true};
  const unknown=store.draft(w,{title:'未知任务',changes:[{op:'create',id:'a-1',kind:'artifact',data:{title:'纪要',taskIds:['nope']}}]});
  assert.throws(()=>store.commit(w,{batchId:unknown.id,revision:1,key:'k1'}),error=>error.code==='REFERENCE','指向不存在的任务必须被拒（REFERENCE）');
  // 新版作用域（2026-10-12）：任务等业务对象是**全局**的，材料按工作区。
  // 所以"别的工区建的材料引用这里的任务"是**合法**的——只有"引用不存在/已归档的任务"才拦。
  const seed=store.draft(w,{title:'seed',changes:[{op:'create',id:'t-1',kind:'task',data:{title:'跟进试点'}}]});
  store.commit(w,{batchId:seed.id,revision:1,key:'seed'});
  const other={workspace:'other',actor:'t',canWrite:true};
  const foreign=store.draft(other,{title:'跨工作区',changes:[{op:'create',id:'a-2',kind:'artifact',data:{title:'纪要',taskIds:['t-1']}}]});
  store.commit(other,{batchId:foreign.id,revision:1,key:'k2'});
  assert.equal(store.list(other,{kind:'artifact',query:'纪要'}).length,1,'材料可以引用全局任务');
  // 已归档的任务不能再被新挂。
  const extra=store.draft(w,{title:'再建一个任务',changes:[{op:'create',id:'t-2',kind:'task',data:{title:'待归档'}}]});
  store.commit(w,{batchId:extra.id,revision:1,key:'t2'});
  const archived=store.draft(w,{title:'归档任务',changes:[{op:'archive',id:'t-2',expectedRevision:1}]});
  store.commit(w,{batchId:archived.id,revision:1,key:'arch'});
  const late=store.draft(w,{title:'挂到已归档任务',changes:[{op:'create',id:'a-3',kind:'artifact',data:{title:'纪要',taskIds:['t-2']}}]});
  assert.throws(()=>store.commit(w,{batchId:late.id,revision:1,key:'k3'}),error=>error.code==='REFERENCE','归档任务不可作为新关联');
 }finally{store.close()}
});

test('a material referencing a task protects that task from deletion and is listed before it',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 try{
  const seed=store.draft(ctx,{title:'会议纪要归档',changes:[
   {op:'create',id:'t-1',kind:'task',data:{title:'跟进试点'}},
   {op:'create',id:'t-2',kind:'task',data:{title:'整理材料'}},
   {op:'create',id:'a-1',kind:'artifact',data:{title:'会议纪要',taskIds:['t-1','t-2']}},
  ]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  assert.deepEqual(store.references(ctx,'t-1').map(ref=>[ref.id,ref.field]),[['a-1','taskIds']],'多对多的引用必须能被 references 找到');
  assert.deepEqual(store.references(ctx,'t-2').map(ref=>[ref.id,ref.field]),[['a-1','taskIds']]);
  const removal=store.draft(ctx,{title:'删除被材料引用的任务',changes:[{op:'delete',id:'t-1',expectedRevision:1}]});
  const preview=store.preview(ctx,removal.id);
  assert(preview.references.some(ref=>ref.id==='a-1'&&ref.field==='taskIds'),'删除前必须先列出是谁引用了它');
  assert.throws(()=>store.commit(ctx,{batchId:removal.id,revision:1,key:'del'}),/仍被 1 个对象引用/,'被材料引用的任务不能直接删除');
  assert.equal(store.get(ctx,'t-1').data.title,'跟进试点','被拒绝的删除不得留下任何改动');
 }finally{store.close()}
});
