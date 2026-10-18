import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkstationStore} from '../src/store.mjs';
import {ROOT_SCOPE,scopeForKind,isWorkspaceScopedKind,readScopes} from '../src/scope.mjs';

const A={workspace:'ws-a',actor:'t',canWrite:true};
const B={workspace:'ws-b',actor:'t',canWrite:true};
const commit=(store,ctx,changes,key)=>{const b=store.draft(ctx,{title:key,changes});return store.commit(ctx,{batchId:b.id,revision:b.revision,key})};

/** 用户 2026-10-12 指出的问题：原来所有数据都以工作区为主键，换工作区就等于换一整套数据，
 *  日历、项目、任务、收件箱在别的工区都看不到。规则改成：**跟着根目录走**，只有材料按工作区。 */

test('作用域规则：全部跟着根目录走（含资料），工作台不随工作区变化',()=>{
 assert.equal(scopeForKind(A,'artifact'),ROOT_SCOPE,'资料也全局：产出跟项目走，不跟工作区走');
 assert.equal(scopeForKind(A,'project'),ROOT_SCOPE);
 assert.equal(scopeForKind(A,'task'),ROOT_SCOPE);
 assert.equal(scopeForKind(A,'event'),ROOT_SCOPE);
 assert.equal(scopeForKind(A,'layout'),ROOT_SCOPE);
 assert(!isWorkspaceScopedKind('artifact'));
 assert(!isWorkspaceScopedKind('project'));
 assert.deepEqual(readScopes(A),[ROOT_SCOPE,'ws-a'],'读取仍是根 + 当前工作区的并集');
});

test('项目/任务/事务/议题/记忆引用/画布布局：换工作区全都看得到',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  commit(store,A,[
   {op:'create',id:'p1',kind:'project',data:{title:'示例科技'}},
   {op:'create',id:'t1',kind:'task',data:{title:'核对指标',projectId:'p1'}},
   {op:'create',id:'e1',kind:'event',data:{title:'与示例客户董事长会面',startDate:'2026-10-12T18:00+08:00'}},
   {op:'create',id:'k1',kind:'topic',data:{title:'试点范围'}},
   {op:'create',id:'m1',kind:'memoryRef',data:{title:'记忆引用',provider:'mnemon-native',reference:'x'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'A 工区的材料',path:'note.md'}},
  ],'seed-a');
  commit(store,B,[{op:'create',id:'a2',kind:'artifact',data:{title:'B 工区的材料',path:'other.md'}}],'seed-b');
  // 在 B 工区：全局对象都在；A 的材料看不到，B 的材料看得到
  const kinds=store.list(B,{limit:100}).map(item=>item.id).sort();
  assert.deepEqual(kinds,['a1','a2','e1','k1','m1','p1','t1'],'B 工区看到全部对象（含资料）');
  for(const id of ['p1','t1','e1','k1','m1','a1'])assert(store.get(B,id),id+' 应当跨工作区可见');
  const idsA=store.list(A,{limit:100}).map(item=>item.id).sort();
  assert.deepEqual(idsA,['a1','a2','e1','k1','m1','p1','t1'],'A 工区看到同一套数据');
  assert.equal(store.get(A,'a2').data.title,'B 工区的材料','资料也全局可见（产出跟项目走）');
 }finally{store.close()}
});

test('收件箱与记录编号是全局的：A 建的待确认的改动 B 能看到并确认，记录编号两边都能取',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const draft=store.draft(A,{title:'待确认',changes:[{op:'create',id:'p1',kind:'project',data:{title:'项目'}}]});
  assert.equal(store.inbox(B).length,1,'别的工区也要看到待确认待确认的改动');
  store.commit(B,{batchId:draft.id,revision:draft.revision,key:'by-b'});
  assert.equal(store.get(A,'p1').data.title,'项目');
  assert(store.receipt(A,'by-b'),'记录编号在根作用域：两边都取得到');
  assert(store.receipt(B,'by-b'));
  assert.equal(store.inbox(A,{status:'committed'}).length,1);
 }finally{store.close()}
});

test('引用完整性不受作用域改造影响：归档被引用的项目仍被拒绝，材料可引用全局任务',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  commit(store,A,[
   {op:'create',id:'p1',kind:'project',data:{title:'项目'}},
   {op:'create',id:'t1',kind:'task',data:{title:'任务',projectId:'p1'}},
  ],'seed');
  const bad=store.draft(A,{title:'归档项目',changes:[{op:'archive',id:'p1',expectedRevision:1}]});
  assert.throws(()=>store.commit(A,{batchId:bad.id,revision:bad.revision,key:'bad'}),error=>error.code==='REFERENCE','被任务引用的项目不能归档');
  // 材料跨工作区引用全局任务是允许的（任务本来就全局）
  commit(store,B,[{op:'create',id:'a1',kind:'artifact',data:{title:'材料',path:'x.md',taskIds:['t1']}}],'link');
  assert.equal(store.get(B,'a1').data.taskIds[0],'t1');
  const missing=store.draft(B,{title:'坏引用',changes:[{op:'create',id:'a2',kind:'artifact',data:{title:'材料2',path:'y.md',taskIds:['nope']}}]});
  assert.throws(()=>store.commit(B,{batchId:missing.id,revision:missing.revision,key:'m'}),error=>error.code==='REFERENCE','指向不存在的任务仍要拒绝');
 }finally{store.close()}
});

test('老库自动迁移：全部数据从工作区搬到根（含资料）',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'ws-scope-')),'data.sqlite');
 const store=new WorkstationStore(path);
 // 直接写入"旧结构"的行：全部挂在真实工作区下（模拟改造前的库）
 const now=new Date().toISOString();
 for(const [id,kind,title] of [['p1','project','项目'],['t1','task','任务'],['a1','artifact','材料']]){
  store.db.prepare('INSERT INTO entities(workspace,id,kind,revision,data,archived) VALUES(?,?,?,?,?,?)').run('ws-a',id,kind,1,JSON.stringify({title}),0);
 }
 store.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run('ws-a','b1',1,'draft',JSON.stringify({title:'旧待确认的改动',changes:[],source:{},author:'t',createdAt:now,updatedAt:now}));
 store.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run('ws-a','k1','h',JSON.stringify({id:'r1',key:'k1'}));
 store.close();
 // 重开 → 构造函数里跑迁移
 const reopened=new WorkstationStore(path);
 try{
  const ctxB={workspace:'ws-b',actor:'t',canWrite:true};
  assert(reopened.get(ctxB,'p1'),'项目应已搬到根作用域 → 别的工区可见');
  assert(reopened.get(ctxB,'t1'),'任务应已搬到根作用域');
  assert(reopened.get(ctxB,'a1'),'资料也搬到根：产出跟项目走，不跟工作区走');
  assert.equal(JSON.parse(reopened.db.prepare('SELECT body FROM batches WHERE workspace=? AND id=?').get(ROOT_SCOPE,'b1').body).title,'旧待确认的改动','旧待确认的改动搬到根');
  assert(reopened.receipt(ctxB,'k1'),'旧记录编号搬到根');
  // 幂等：再开一次不会重复或丢数据
  reopened.migrateScopes();
  assert.equal(reopened.list(ctxB,{limit:10}).filter(item=>item.kind==='project').length,1);
 }finally{reopened.close()}
});
