import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter,toolDefinition} from '../src/dsh-adapter.mjs';
const exec={agent:{id:'session-real'},callId:'call',signal:new AbortController().signal};
function setup(outcome='allowed-once'){const store=new WorkstationStore(':memory:');const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/trusted'}})},workspaceRegistry:{resolveByPath:async()=>({id:'trusted'})},approval:{request:async()=>outcome},allowedWorkspaces:['trusted']});return {store,adapter};}
test('host context binding, tool registration contract and actual commit',async()=>{const {store,adapter}=setup();try{const tool=toolDefinition(adapter);assert.equal(tool.name,'workstation');const b=await tool.execute({action:'draft',title:'create',changes:[{op:'create',kind:'project',id:'p',data:{title:'项目'}}]},exec);const r=await tool.execute({action:'commit',id:b.id,revision:b.revision,key:'unique'},exec);assert.equal(r.status,'committed');assert.equal((await adapter.run({action:'get',id:'p'},exec)).item.data.title,'项目');await assert.rejects(adapter.run({action:'list',workspace:'other'},exec),{code:'INVALID'});}finally{store.close()}});
test('approval denial and absent session fail closed for business writes',async()=>{
 const {store,adapter}=setup('unavailable');
 try{
  // 草稿是待处理的建议，不改变业务数据，因此不需要审批（PRD v1.3 CH-06-2）。
  const draft=await adapter.run({action:'draft',title:'建议',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}]},exec);
  assert.equal(store.inbox({workspace:'trusted',actor:'test'}).length,1,'待确认的改动应当落进收件箱等待处理');
  assert.equal(store.list({workspace:'trusted',actor:'test'}).length,0,'待确认的改动不得改变业务数据');
  // 提交才改变业务数据，审批被拒必须失败且不写入。
  await assert.rejects(adapter.run({action:'commit',id:draft.id,revision:1,key:'k'},exec),{code:'FORBIDDEN'});
  assert.equal(store.list({workspace:'trusted',actor:'test'}).length,0);
  await assert.rejects(adapter.run({action:'list'},{signal:exec.signal}),{code:'UNAUTHORIZED'});
 }finally{store.close()}
});
test('revocation while approval waits prevents the commit',async()=>{
 const {store,adapter}=setup();
 try{
  const draft=await adapter.run({action:'draft',title:'建议',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}]},exec);
  adapter.approval.request=async()=>{adapter.allowedSource=[];return 'allowed-once'};
  await assert.rejects(adapter.run({action:'commit',id:draft.id,revision:1,key:'k'},exec),{code:'FORBIDDEN'});
  assert.equal(store.list({workspace:'trusted',actor:'test'}).length,0);
 }finally{store.close()}
});
