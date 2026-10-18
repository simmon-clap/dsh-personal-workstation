import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationStore } from '../src/store.mjs';
const ctx={workspace:'a',actor:'human',canWrite:true};
test('atomic batch references, idempotency, isolation and stale writes',()=>{
 const s=new WorkstationStore(':memory:');
 try{
 const b=s.draft(ctx,{title:'会议归档',changes:[{op:'create',id:'p',kind:'project',data:{title:'项目'}},{op:'create',id:'t',kind:'task',data:{title:'任务',projectId:'p'}}]});
 const r=s.commit(ctx,{batchId:b.id,revision:1,key:'one'});assert.equal(r.after.length,2);assert.deepEqual(s.commit(ctx,{batchId:b.id,revision:1,key:'one'}),r);
 // 新版作用域：全局对象在所有工作区都可见（只有材料按工作区隔离）
 assert.equal(s.get({...ctx,workspace:'b'},'p').data.title,'项目');
 const stale=s.draft(ctx,{title:'过期',changes:[{op:'update',id:'p',expectedRevision:2,data:{title:'错'}}]});assert.throws(()=>s.commit(ctx,{batchId:stale.id,revision:1,key:'stale'}),{code:'CONFLICT'});assert.equal(s.get(ctx,'p').data.title,'项目');
 assert.throws(()=>s.draft({...ctx,canWrite:false},{title:'非法',changes:[]}),{code:'FORBIDDEN'});
 }finally{s.close();}
});
test('reference failure rolls back the entire batch',()=>{const s=new WorkstationStore(':memory:');try{const b=s.draft(ctx,{title:'失败待确认的改动',changes:[{op:'create',id:'p',kind:'project',data:{title:'不应保存'}},{op:'create',id:'t',kind:'task',data:{title:'任务',projectId:'missing'}}]});assert.throws(()=>s.commit(ctx,{batchId:b.id,revision:1,key:'x'}),{code:'REFERENCE'});assert.equal(s.get(ctx,'p'),null);assert.equal(s.batch(ctx,b.id).status,'draft');}finally{s.close()}});
