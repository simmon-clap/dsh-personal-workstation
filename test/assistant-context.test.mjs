import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter,toolDefinition} from '../src/dsh-adapter.mjs';
import {assembleContext} from '../src/context-assembler.mjs';

const ctx={workspace:'trusted',actor:'agent',canWrite:false};
const write=(store,changes,title='seed')=>{const c={workspace:'trusted',actor:'agent',canWrite:true};const d=store.draft(c,{title,changes});return store.commit(c,{batchId:d.id,revision:1,key:title+'-'+Math.random()})};

function seeded(){const store=new WorkstationStore(':memory:');write(store,[{op:'create',id:'p1',kind:'project',data:{title:'示例科技 3D 存算一体',goal:'看 decode 场景适配'}}]);write(store,[{op:'create',id:'t1',kind:'task',data:{title:'跑 decode 与带宽验证',projectId:'p1',status:'in_progress',dueDate:new Date(Date.now()+2*86400000).toISOString().slice(0,10)}}]);write(store,[{op:'create',id:'j2',kind:'judgment',data:{title:'带宽数字是对方自述',status:'current',validFrom:'2026-09-02',uncertainty:'四条成本数字未经第三方验证',evidence:[{kind:'message',ref:'msg-1',quote:'对方说 4W 功耗'}]}}]);write(store,[{op:'create',id:'j1',kind:'judgment',data:{title:'合资+垫资模式长期有风险',status:'checking',uncertainty:'尚未核对对方已有的合资案',validFrom:'2026-09-01',evidence:[{kind:'file',ref:'纪要#3',quote:'合资 + 垫资 + 绑地方政府财政'}]}}]);write(store,[{op:'create',id:'m1',kind:'memoryRef',data:{title:'上次的提醒',content:'先做 decode 适配，再谈合资',provider:'mnemon',reference:'mem-1'}}]);store.draft({workspace:'trusted',actor:'agent',canWrite:true},{title:'建议：直接安排与股东见面',proposal:{decision:'rejected',reason:'优先级不对，先看技术再谈股权',decidedAt:'2026-10-17T08:00:00.000Z'},changes:[{op:'create',id:'x-advice-1',kind:'task',data:{title:'安排股东见面'}}]});
 return store}
const session=()=>({id:'session-1',header:{cwd:'/trusted'},deriveMessages:()=>[
 {role:'user',content:[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'}]},
 {role:'user',content:[{type:'text',text:'把示例科技这段会议材料整理成判断'}]},
 {role:'tool',content:[{type:'text',text:'工具输出不应进入会话要点'}]},
 {role:'assistant',content:[{type:'text',text:'我建议先写三条判断，并标出两条不确定性。'}]},
]});
const knowledge=(hits=[{baseId:'kb1',docId:'doc-1',chunkId:'chunk-1',documentTitle:'会议纪要',text:'合资 + 垫资 + 绑地方政府财政…'}],override)=>({grants:[{workspace:'trusted',baseId:'kb1'}],search:async()=>override??{hits}});

test('context assembler returns related objects, last judgment, checks, promises, session points and sourced evidence',async()=>{
 const store=seeded();
 try{
  const result=await assembleContext({store,ctx,query:'示例科技 decode 带宽',knowledge:knowledge(),sessions:{get:session},agentId:'agent',now:new Date('2026-10-18T02:00:00Z')});
  assert.equal(result.related.project[0]?.id,'p1');
  assert.equal(result.related.task[0]?.id,'t1');
  assert.equal(result.lastJudgment.id,'j1','最近一条判断要带出来');
  assert.equal(result.lastJudgment.evidenceCount,1);
  assert.match(result.lastJudgment.uncertainty,/尚未核对/);
  assert.equal(result.pendingChecks.length,1,'除最近一条外，还有不确定性的判断应进待核对');
  assert.equal(result.pendingChecks[0].judgmentId,'j2');
  assert.match(result.pendingChecks[0].question,/第三方验证/);
  assert.equal(result.promises.dueSoon[0]?.id,'t1','7 天内到期的任务算承诺');
  assert.deepEqual(result.recentSession.messages.map(m=>m.role),['user','assistant'],'工具调用不进会话要点');
  assert.match(result.recentSession.messages[0].text,/整理成判断/);
  assert.equal(result.knowledge.status,'ok');
  assert.equal(result.knowledge.evidence[0].chunkId,'chunk-1','知识证据必须带 chunk 出处');
  assert.equal(result.memoryRefs[0]?.id,'m1');
  assert.match(result.memoryRefs[0].quote,/decode/);
  assert.ok('verification' in result.memoryRefs[0],'记忆引用要带核对结果字段（没有就是 null，不猜）');
  assert.equal(result.recentAdviceFeedback[0]?.decision,'你否决过','上一轮的否决理由要先读出来');
  assert.match(result.recentAdviceFeedback[0]?.reason,/优先级不对/);
  // 工具返回值必须无损 JSON（宿主会拒收 undefined/NaN 等）
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
 }finally{store.close()}
});

test('honest states: no knowledge grant / unavailable service / no sessions are stated, not invented',async()=>{
 const store=seeded();
 try{
  const noGrant=await assembleContext({store,ctx,query:'示例科技',knowledge:{grants:[],search:async()=>({hits:[]})}});
  assert.equal(noGrant.knowledge.status,'not-configured');
  assert.deepEqual(noGrant.knowledge.evidence,[]);
  assert.equal(noGrant.recentSession,null,'没有会话服务时不能编会话要点');
  const down=await assembleContext({store,ctx,query:'示例科技',knowledge:{grants:[{workspace:'trusted',baseId:'kb1'}],search:async()=>{const error=Error('知识服务未接入');error.code='UNAVAILABLE';throw error}}});
  assert.equal(down.knowledge.status,'unavailable');
  await assert.rejects(assembleContext({store,ctx,query:'   '}),{code:'INVALID'});
 }finally{store.close()}
});

test('the workstation tool exposes assistant_context as a read-only action',async()=>{
 const store=seeded();
 const adapter=new DshAdapter({store,sessions:{get:session},workspaceRegistry:{resolveByPath:async()=>({id:'trusted'})},approval:{request:async()=>'allowed-once'},allowedWorkspaces:['trusted'],knowledge:knowledge()});
 const exec={agent:{id:'agent'},signal:new AbortController().signal};
 try{
  const tool=toolDefinition(adapter);
  assert.ok(tool.parameters.properties.action.enum.includes('assistant_context'));
  assert.equal(tool.isConcurrencySafe({action:'assistant_context'}),true,'只读动作应允许并发');
  const result=await tool.execute({action:'assistant_context',query:'示例科技'},exec);
  assert.equal(result.related.project[0].id,'p1');
  await assert.rejects(tool.execute({action:'assistant_context',workspace:'other'},exec),{code:'INVALID'});
 }finally{store.close()}
});
