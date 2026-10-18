import {test} from 'node:test';import assert from 'node:assert/strict';import {WorkstationStore} from '../src/store.mjs';

/**
 * 宿主要求工具返回值是「无损 JSON」：嵌套的 undefined / NaN / Infinity / -0 / BigInt /
 * 函数 / class 实例 / 稀疏数组 / 循环引用，都会让整次工具调用被拒：
 *   tool "workstation" returned invalid output: value is not lossless JSON
 * 最难察觉的是 `{key: undefined}`：JSON.stringify 会静默丢掉这个键，所以肉眼和
 * 「看 JSON 字符串」都发现不了；只有往返后做深度比较（或检查键是否还在）才暴露。
 */
function assertLossless(value,label='preview'){
 assert.deepEqual(JSON.parse(JSON.stringify(value)),value,label+' 必须无损往返 JSON（往返后与原值深度相等）');
 const offenders=[];
 (function walk(node,path){
  if(node===undefined){offenders.push(path+' = undefined');return}
  if(typeof node==='number'&&!Number.isFinite(node)){offenders.push(path+' = '+node);return}
  if(typeof node==='bigint'||typeof node==='function'||typeof node==='symbol'){offenders.push(path+' = '+typeof node);return}
  if(Array.isArray(node)){node.forEach((item,index)=>walk(item,path+'['+index+']'));return}
  if(node&&typeof node==='object'){
   const proto=Object.getPrototypeOf(node);
   if(proto!==Object.prototype&&proto!==null)offenders.push(path+' 不是纯对象（'+(node.constructor?.name??'unknown')+'）');
   for(const [key,item] of Object.entries(node))walk(item,path+'.'+key);
  }
 })(value,label);
 assert.deepEqual(offenders,[],label+' 含非 JSON 值：'+offenders.join('、'));
}

const ctx={workspace:'w',actor:'agent',canWrite:true};
const fresh=()=>new WorkstationStore(':memory:');
const eventData={title:'与示例客户董事长会面',startDate:'2026-10-13T10:00:00+08:00',endDate:'2026-10-13T11:00:00+08:00'};

// 复现 #2（1.6.2，2026-10-12 16:43）：空库 + create-only + kind=event，库里此前没有任何 event。
test('preview：空库 + create-only 日程（复现待确认的改动 d38f66aa…）无损往返',()=>{
 const s=fresh();
 try{
  const b=s.draft(ctx,{title:'新建日程：与示例客户董事长会面',changes:[{op:'create',kind:'event',data:{...eventData}}]},'d38f66aa-54c6-4396-9ee9-a9847e97a193');
  const preview=s.preview(ctx,b.id);
  assert.equal(preview.status,'draft');
  assert.deepEqual(preview.validationErrors,[]);
  assert.equal(preview.diff.length,1);
  assert.equal(preview.diff[0].before,null);
  assertLossless(preview);
 }finally{s.close()}
});

// 复现 #1（2026-10-12 上午）：会议纪要归档，空库 + 7 项 create。
test('preview：空库 + 7 项 create（复现待确认的改动 c1655921…）无损往返',()=>{
 const s=fresh();
 try{
  const changes=Array.from({length:7},(_,index)=>({op:'create',kind:'artifact',id:'artifact-'+index,data:{title:'会议纪要 '+(index+1),path:'会议/纪要-'+(index+1)+'.md'}}));
  const b=s.draft(ctx,{title:'会议纪要归档',changes},'c1655921-a901-460b-af3f-0158cbcd1445');
  const preview=s.preview(ctx,b.id);
  assert.equal(preview.diff.length,7);
  for(const entry of preview.diff){assert.equal(entry.op,'create');assert.equal(entry.before,null);assert.equal(Object.hasOwn(entry,'archivedData'),false)}
  assertLossless(preview);
 }finally{s.close()}
});

// 每种 op 单独一批，外加一个 5 种 op 混在一起的批次。
test('preview：create / update / archive / restore / delete / 混合待确认的改动都无损往返',()=>{
 const s=fresh();
 try{
  const seed=s.draft(ctx,{title:'铺底',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'P1'}},
   {op:'create',id:'p2',kind:'project',data:{title:'P2'}},
   {op:'create',id:'p3',kind:'project',data:{title:'P3'}},
   {op:'create',id:'p4',kind:'project',data:{title:'P4'}},
  ]});
  s.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  const archived=s.draft(ctx,{title:'先归档 p4',changes:[{op:'archive',id:'p4',expectedRevision:1}]});
  s.commit(ctx,{batchId:archived.id,revision:1,key:'arch-p4'});
  const cases={
   create:[{op:'create',id:'p5',kind:'project',data:{title:'P5'}}],
   update:[{op:'update',id:'p1',expectedRevision:1,data:{title:'P1x'}}],
   archive:[{op:'archive',id:'p2',expectedRevision:1}],
   restore:[{op:'restore',id:'p4',expectedRevision:2}],
   delete:[{op:'delete',id:'p3',expectedRevision:1}],
   mixed:[
    {op:'create',id:'p6',kind:'project',data:{title:'P6'}},
    {op:'update',id:'p1',expectedRevision:1,data:{title:'P1y'}},
    {op:'archive',id:'p2',expectedRevision:1},
    {op:'restore',id:'p4',expectedRevision:2},
    {op:'delete',id:'p3',expectedRevision:1},
   ],
  };
  for(const [name,changes] of Object.entries(cases)){
   const b=s.draft(ctx,{title:name,changes});
   const preview=s.preview(ctx,b.id);
   assert.equal(preview.diff.length,changes.length,'待确认的改动 '+name+' 的 diff 条数');
   assertLossless(preview,'preview('+name+')');
  }
  // 归档项才带 archivedData；其它 op 不再挂一个值为 undefined 的键。
  const restorePreview=s.preview(ctx,s.draft(ctx,{title:'restore-only',changes:[{op:'restore',id:'p4',expectedRevision:2}]}).id);
  assert.equal(Object.hasOwn(restorePreview.diff[0],'archivedData'),false);
  const archivePreview=s.preview(ctx,s.draft(ctx,{title:'archive-only',changes:[{op:'archive',id:'p2',expectedRevision:1}]}).id);
  assert.deepEqual(archivePreview.diff[0].archivedData,{title:'P2'});
 }finally{s.close()}
});

// 恢复的「修改后」必须是库里真实内容：以前这里取的是变更里没带的数据 → undefined。
test('preview：restore 项的 after 报告恢复后的真实内容而不是 undefined',()=>{
 const s=fresh();
 try{
  const seed=s.draft(ctx,{title:'铺底',changes:[{op:'create',id:'p',kind:'project',data:{title:'P',goal:'目标'}}]});
  s.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  const arch=s.draft(ctx,{title:'归档',changes:[{op:'archive',id:'p',expectedRevision:1}]});
  s.commit(ctx,{batchId:arch.id,revision:1,key:'arch'});
  const preview=s.preview(ctx,s.draft(ctx,{title:'恢复',changes:[{op:'restore',id:'p',expectedRevision:2}]}).id);
  assert.deepEqual(preview.diff[0].after,{title:'P',goal:'目标'});
  assert.equal(preview.diff[0].before.archived,true);
 }finally{s.close()}
});

// 已提交批次的 preview 走回执快照分支，是另一处独立构造返回值的地方。
test('preview：已提交待确认的改动（create/update/archive/delete 记录编号）与撤销待确认的改动都无损往返',()=>{
 const s=fresh();
 try{
  const created=s.draft(ctx,{title:'create',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}]});
  s.commit(ctx,{batchId:created.id,revision:1,key:'c'});
  assertLossless(s.preview(ctx,created.id),'preview(committed create)');
  const updated=s.draft(ctx,{title:'update',changes:[{op:'update',id:'p',expectedRevision:1,data:{title:'P2'}}]});
  s.commit(ctx,{batchId:updated.id,revision:1,key:'u'});
  assertLossless(s.preview(ctx,updated.id),'preview(committed update)');
  const archived=s.draft(ctx,{title:'archive',changes:[{op:'archive',id:'p',expectedRevision:2}]});
  s.commit(ctx,{batchId:archived.id,revision:1,key:'a'});
  const archivedPreview=s.preview(ctx,archived.id);
  assertLossless(archivedPreview,'preview(committed archive)');
  assert.deepEqual(archivedPreview.diff[0].archivedData,{title:'P2'});
  assert.equal(archivedPreview.diff[0].after,null);
  const undo=s.undoDraft(ctx,'a');
  assertLossless(s.preview(ctx,undo.id),'preview(undo draft)');
  const createdForDelete=s.draft(ctx,{title:'create q',changes:[{op:'create',id:'q',kind:'project',data:{title:'Q'}}]});
  s.commit(ctx,{batchId:createdForDelete.id,revision:1,key:'q'});
  const deleted=s.draft(ctx,{title:'delete',changes:[{op:'delete',id:'q',expectedRevision:1}]});
  s.commit(ctx,{batchId:deleted.id,revision:1,key:'d'});
  assertLossless(s.preview(ctx,deleted.id),'preview(committed delete)');
  assertLossless(s.receipt(ctx,'a'),'receipt');
  assertLossless(s.inbox(ctx),'inbox');
 }finally{s.close()}
});
