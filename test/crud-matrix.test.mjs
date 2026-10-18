import {test} from 'node:test';import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';

/** CRUD 完整性矩阵：8 类对象 × 增/改/删/查 都必须真的可用。
 *  删除是本轮新加的（此前只有归档）；这里逐类跑一遍，缺哪格一眼可见。 */
const KINDS={
 project:{title:'联合验证',fields:{}},
 task:{title:'试点方案整理',fields:{}},
 artifact:{title:'会议纪要',fields:{path:'notes/a.md',fileGrantId:'g1',fileVersion:'v1'}},
 topic:{title:'推理框架',fields:{content:'待验证'}},
 event:{title:'周会',fields:{startDate:'2026-10-12',endDate:'2026-10-12'}},
 memoryRef:{title:'过往试点经验',fields:{provider:'mnemon',reference:'user.md#a'}},
 organization:{title:'伙伴 A',fields:{}},
 person:{title:'张工',fields:{}},
};

test('every object kind supports create, read, update, archive, delete and restore',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'crud',canWrite:true};
 try{
  for(const [kind,spec]of Object.entries(KINDS)){
   const id='x-'+kind;
   // 增
   const created=store.draft(ctx,{title:'建'+kind,changes:[{op:'create',id,kind,data:{title:spec.title,...spec.fields}}]});
   store.commit(ctx,{batchId:created.id,revision:1,key:'create-'+kind});
   // 查
   const item=store.get(ctx,id);
   assert(item,'查：'+kind+'创建后必须能读到');
   assert.equal(item.data.title,spec.title);
   // 改
   const updated=store.draft(ctx,{title:'改'+kind,changes:[{op:'update',id,expectedRevision:item.revision,data:{...item.data,description:'补充'}}]});
   store.commit(ctx,{batchId:updated.id,revision:1,key:'update-'+kind});
   assert.equal(store.get(ctx,id).data.description,'补充','改：'+kind);
   // 归档 + 恢复
   const archived=store.draft(ctx,{title:'归档'+kind,changes:[{op:'archive',id,expectedRevision:2}]});
   store.commit(ctx,{batchId:archived.id,revision:1,key:'archive-'+kind});
   assert.equal(store.get(ctx,id).archived,true,'归档：'+kind);
   const restored=store.draft(ctx,{title:'恢复'+kind,changes:[{op:'restore',id,expectedRevision:3}]});
   store.commit(ctx,{batchId:restored.id,revision:1,key:'restore-'+kind});
   assert.equal(store.get(ctx,id).archived,false,'恢复：'+kind);
   // 删（真删，不是归档）
   const deleted=store.draft(ctx,{title:'删'+kind,changes:[{op:'delete',id,expectedRevision:4}]});
   const receipt=store.commit(ctx,{batchId:deleted.id,revision:1,key:'delete-'+kind});
   assert.equal(store.get(ctx,id),null,'删：'+kind+'必须真的从库里消失');
   // 删完还能撤销恢复
   const undo=store.writeUndoDraft(ctx,receipt.key);
   store.commit(ctx,{batchId:undo.id,revision:1,key:'undo-'+kind});
   assert.equal(store.get(ctx,id)?.data?.title,spec.title,'撤销：'+kind+'删除后必须能恢复');
  }
 }finally{store.close()}
});

test('delete refuses while other records still reference the object, and says who',()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'crud',canWrite:true};
 try{
  const seed=store.draft(ctx,{title:'种子',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'联合验证'}},
   {op:'create',id:'t1',kind:'task',data:{title:'试点方案整理',projectId:'p1'}},
  ]});
  store.commit(ctx,{batchId:seed.id,revision:1,key:'k1'});
  const attempt=store.draft(ctx,{title:'删除项目',changes:[{op:'delete',id:'p1',expectedRevision:1}]});
  const preview=store.preview(ctx,attempt.id);
  assert.equal(preview.references.length,1,'预览必须列出引用方');
  assert.match(preview.references[0].title,/试点方案整理/);
  assert.throws(()=>store.commit(ctx,{batchId:attempt.id,revision:1,key:'k2'}),/仍被 1 个对象引用/,'提交必须硬拦，不能留下悬空引用');
  // 解除引用后可以删
  store.cancelDraft(ctx,attempt.id,1);
  const clear=store.draft(ctx,{title:'解除引用',changes:[{op:'update',id:'t1',expectedRevision:1,data:{title:'试点方案整理'}}]});
  store.commit(ctx,{batchId:clear.id,revision:1,key:'k3'});
  const again=store.draft(ctx,{title:'删除项目',changes:[{op:'delete',id:'p1',expectedRevision:1}]});
  store.commit(ctx,{batchId:again.id,revision:1,key:'k4'});
  assert.equal(store.get(ctx,'p1'),null,'解除引用后删除应当成功');
 }finally{store.close()}
});
