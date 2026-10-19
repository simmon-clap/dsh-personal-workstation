import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {graph,relationStale} from '../src/graph.mjs';

// PRD v1.0 KN-06 / v1.1 IN-AC-9：来源变化或对象不可用后，已确认关系必须变成待复核，不能继续冒充事实。
function setup(){
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const commit=changes=>{const batch=store.draft(ctx,{title:'r',changes});return store.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()})};
 commit([{op:'create',id:'a',kind:'artifact',data:{title:'资料'}}]);
 // 项目单独一批：同批新建「1 个项目 + 资料」会把资料自动归属到该项目（体检 A2），
 // 那会多出一条归属引用，让下面"归档端点必须被拒绝"的用例改成因为归属而不是关系被拦。
 commit([{op:'create',id:'p',kind:'project',data:{title:'项目'}}]);
 return {store,ctx,commit,edges:()=>graph(store,ctx,{}).edges,relations:()=>graph(store,ctx,{}).relations};
}
test('a confirmed relation records the versions it was confirmed against',()=>{
 const {store,ctx,commit,edges}=setup();
 try{
  commit([{op:'create',id:'r',kind:'relation',data:{title:'引用',from:'a',to:'p',status:'confirmed',evidence:'项目引用该资料',basis:['a@1','p@1']}}]);
  const edge=edges().find(item=>item.id==='r');
  assert.equal(edge.stale,null,'依据与当前版本一致时不应报待复核');
  assert.deepEqual(edge.basis,['a@1','p@1']);
  void ctx;
 }finally{store.close()}
});
test('updating one side turns the confirmed relation into 待复核 without touching the data',()=>{
 const {store,ctx,commit,edges}=setup();
 try{
  commit([{op:'create',id:'r',kind:'relation',data:{title:'引用',from:'a',to:'p',status:'confirmed',evidence:'项目引用该资料',basis:['a@1','p@1']}}]);
  commit([{op:'update',id:'p',expectedRevision:1,data:{title:'项目（改名）'}}]);
  const edge=edges().find(item=>item.id==='r');
  assert.match(edge.stale,/已更新/,'来源更新后必须报待复核');
  assert.match(edge.stale,/项目（改名）/,'原因里要点出是哪个对象变了');
  assert.equal(store.get(ctx,'r').data.status,'confirmed','判定只报告状态，不得私自改写关系');
  commit([{op:'update',id:'r',expectedRevision:1,data:{...store.get(ctx,'r').data,basis:['a@1','p@2']}}]);
  assert.equal(edges().find(item=>item.id==='r').stale,null,'重新确认后必须恢复可信');
 }finally{store.close()}
});
test('stored integrity still blocks archiving an endpoint, and legacy orphans stay visible',()=>{
 const {store,ctx,commit,edges,relations}=setup();
 try{
  commit([{op:'create',id:'r',kind:'relation',data:{title:'引用',from:'a',to:'p',status:'confirmed',evidence:'项目引用该资料',basis:['a@1','p@1']}}]);
  assert.throws(()=>commit([{op:'archive',id:'p',expectedRevision:1}]),/关系端点不可用|REFERENCE/,'端点被引用时归档必须被拒绝，而不是留下断链关系');
  // 防御路径：历史或导入数据里可能存在端点不存在的已确认关系，画布必须把它标成待复核而不是静默丢弃。
  store.db.prepare('INSERT INTO entities(workspace,id,kind,revision,data,archived) VALUES(?,?,?,?,?,?)').run('w','legacy',  'relation',1,JSON.stringify({title:'历史引用',from:'a',to:'gone',status:'confirmed',evidence:'来自旧数据'}),0);
  const edge=relations().find(item=>item.id==='legacy');
  assert(edge,'端点缺失的关系不能从列表里消失');
  assert.equal(edge.missing,true);
  assert.match(edge.stale,/已不可用/);
 }finally{store.close()}
});
test('suggested relations without a recorded basis are not reported as stale',()=>{
 const {store,ctx,commit,edges}=setup();
 try{
  commit([{op:'create',id:'r',kind:'relation',data:{title:'建议',from:'a',to:'p',status:'suggested',evidence:'看起来相关'}}]);
  commit([{op:'update',id:'p',expectedRevision:1,data:{title:'项目（改名）'}}]);
  assert.equal(edges().find(item=>item.id==='r').stale,null,'未确认的建议本来就不该被当成事实');
 }finally{store.close()}
});
test('staleness is derived from stored basis only, and malformed basis is rejected at write time',()=>{
 assert.equal(relationStale({status:'confirmed',from:'a',to:'b',basis:['a@2']},{get:id=>id==='a'?{id:'a',revision:2}:undefined}),null);
 assert.match(relationStale({status:'confirmed',from:'a',to:'b',basis:['a@1']},{get:id=>id==='a'?{id:'a',revision:2}:undefined}),/已更新/);
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 try{
  store.commit(ctx,{batchId:store.draft(ctx,{title:'seed',changes:[{op:'create',id:'a',kind:'artifact',data:{title:'A'}},{op:'create',id:'b',kind:'artifact',data:{title:'B'}}]}).id,revision:1,key:'seed'});
  for(const basis of [['a'],['a@0'],['@1'],[1],'a@1']){
   const batch=store.draft(ctx,{title:'x',changes:[{op:'create',id:'r'+Math.random(),kind:'relation',data:{title:'t',from:'a',to:'b',status:'confirmed',evidence:'e',basis}}]});
   assert.throws(()=>store.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()}),/关系依据/,'非法依据必须被拒绝：'+JSON.stringify(basis));
  }
 }finally{store.close()}
});
