import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';
import {knowledgeState,phaseOf,ingestFile} from '../src/knowledge-ingest.mjs';

// PRD v1.0 KN-05 / v1.1 IN-AC-8：归档完成、索引中、失败及部分成功要能准确区分。
// 收录与索引由宿主知识库服务负责；这里用契约替身验证映射与分阶段报告，不写入真实知识库。
const BASE='base-1';
function setup({service,grants=[{workspace:'w',baseId:BASE,read:true}],files=true,approval='allowed-once'}={}){
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const batch=store.draft(ctx,{title:'材料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',path:'meetings/a.md',fileGrantId:'g1',fileVersion:'v1',content:'原文'}}]});
 store.commit(ctx,{batchId:batch.id,revision:1,key:'k'});
 const adapter=new DshAdapter({store,sessions:{get:id=>id==='s'?{header:{cwd:'/w'}}:null},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w',title:'W'})},allowedWorkspaces:['w'],approval:{request:async()=>approval},knowledge:{service,grants},
  files:files?{hostPath:async(ctx,{grantId,path})=>{if(grantId!=='g1')throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});return {hostPath:'/files/'+path,workspaceRoot:'/files',version:'v1',size:3}}}:undefined});
 return {store,adapter,call:(action,args={})=>adapter.run({action,...args},{agent:{id:'s'},callId:'c1'})};
}
test('each indexing phase maps to a distinct, honest label',()=>{
 assert.equal(phaseOf('processing').phase,'processing');
 assert.equal(phaseOf('ready').phase,'ready');
 assert.equal(phaseOf('failed').phase,'failed');
 assert.equal(phaseOf('something-new').phase,'unknown','未知状态必须标为未知');
 assert.equal(phaseOf(undefined).phase,'unknown');
 assert.equal(phaseOf('something-new').raw,'something-new','原始状态要原样带回');
});
test('the status reader distinguishes indexing, done, failed, deleted and unreadable',async()=>{
 const service={
  listDocuments:async()=>[{id:'d1',status:'processing',chunkCount:0},{id:'d2',status:'ready',chunkCount:12},{id:'d3',status:'failed',chunkCount:0}],
  getJob:async(baseId,id)=>id==='d1'?{status:'processing',progress:42}:id==='d3'?{status:'failed',error:'嵌入模型不可用'}:{status:'ready',progress:100},
 };
 assert.equal((await knowledgeState(service,{baseId:BASE,documentId:'d1'})).status,'processing');
 assert.equal((await knowledgeState(service,{baseId:BASE,documentId:'d1'})).progress,42,'检索中要给出进度');
 const done=await knowledgeState(service,{baseId:BASE,documentId:'d2'});
 assert.equal(done.status,'ready');assert.equal(done.chunkCount,12);
 const failed=await knowledgeState(service,{baseId:BASE,documentId:'d3'});
 assert.equal(failed.status,'failed');assert.match(failed.message,/嵌入模型不可用/,'失败原因必须转达');
 assert.equal((await knowledgeState(service,{baseId:BASE,documentId:'gone'})).status,'not-found');
 assert.equal((await knowledgeState(undefined,{baseId:BASE,documentId:'d1'})).available,false);
 assert.equal((await knowledgeState({listDocuments:async()=>{throw new Error('库不可读')}},{baseId:BASE,documentId:'d1'})).available,false);
 assert.equal((await knowledgeState(service,{baseId:BASE})).available,false,'缺少文档标识时不能猜');
});
test('ingesting a granted file reports the staged result without claiming the index finished',async()=>{
 const imported=[];
 const service={importFileFromPath:async(baseId,filePath)=>{imported.push({baseId,filePath});return {id:'d9',status:'processing',chunkCount:0}}};
 const {store,call}=setup({service});
 try{
  const result=await call('knowledge_ingest',{id:'a1',baseId:BASE});
  assert.deepEqual(imported,[{baseId:BASE,filePath:'/files/meetings/a.md'}],'必须用授权解析出的宿主路径存进知识库');
  assert.equal(result.staged[0].stage,'ingest');assert.equal(result.staged[0].status,'processing');
  const record=result.staged.find(step=>step.stage==='record');
  assert.equal(record.ok,true);
  assert.equal(result.available,true);
  const draft=store.batch({workspace:'w',actor:'t'},record.batchId);
  assert.equal(draft.changes[0].data.knowledgeBaseId,BASE);
  assert.equal(draft.changes[0].data.knowledgeDocId,'d9');
  assert.equal(store.get({workspace:'w',actor:'t'},'a1').data.knowledgeDocId,undefined,'待确认的改动未确认前不得改记录');
 }finally{store.close()}
});
test('an unauthorized base or an unauthorized file is refused before anything is imported',async()=>{
 let imported=0;
 const service={importFileFromPath:async()=>{imported+=1;return {id:'d',status:'processing'}}};
 const unauthorizedBase=setup({service,grants:[{workspace:'w',baseId:'other',read:true}]});
 try{await assert.rejects(unauthorizedBase.call('knowledge_ingest',{id:'a1',baseId:BASE}),/未授权/,'未授权的知识库必须拒绝');assert.equal(imported,0)}finally{unauthorizedBase.store.close()}
 const noFiles=setup({service,files:false});
 try{await assert.rejects(noFiles.call('knowledge_ingest',{id:'a1',baseId:BASE}),/文件服务未接入/);assert.equal(imported,0)}finally{noFiles.store.close()}
 const noService=setup({service:undefined});
 try{await assert.rejects(noService.call('knowledge_ingest',{id:'a1',baseId:BASE}),/知识服务未接入/)}finally{noService.store.close()}
});
test('a partial failure is reported stage by stage instead of as a blanket failure',async()=>{
 const service={importFileFromPath:async()=>({id:'d9',status:'processing'})};
 const {store,adapter}=setup({service});
 // 让「把标识写回记录」这一步失败：收录已经发生，但记录写不进去。
 // 只替换 draft 这一个方法，保留 store 的其余能力。
 store.draft=()=>{throw new Error('待确认的改动写入失败')};
 try{
  const result=await adapter.run({action:'knowledge_ingest',id:'a1',baseId:BASE},{agent:{id:'s'},callId:'c1'});
  assert.equal(result.staged[0].stage,'ingest');
  assert.equal(result.staged[0].ok,true,'存进知识库这一步已经发生，必须如实报告成功');
  const record=result.staged.find(step=>step.stage==='record');
  assert.equal(record.ok,false);
  assert.match(record.reason,/没能写进工作台|写入失败/,'第二步失败必须给出原因');
  assert.equal(result.available,false,'有任一步失败就不能报整体成功');
  assert.equal(store.get({workspace:'w',actor:'t'},'a1').data.knowledgeDocId,undefined,'保存回失败不得留下半个标识');
 }finally{store.close()}
});
test('ingesting requires approval because it writes to another system',async()=>{
 let imported=0;
 const service={importFileFromPath:async()=>{imported+=1;return {id:'d9',status:'processing'}}};
 const {store,call}=setup({service,approval:'rejected'});
 try{
  await assert.rejects(call('knowledge_ingest',{id:'a1',baseId:BASE}),/未获许可/);
  assert.equal(imported,0,'没有批准时不得写入知识库');
  assert.equal(store.inbox({workspace:'w',actor:'t'},{status:'draft'}).length,0);
 }finally{store.close()}
});
test('ingestFile refuses an unsupported extension through the host service and surfaces why',async()=>{
 const service={importFileFromPath:async()=>{throw new Error('Unsupported knowledge file type: a.exe')}};
 const files={hostPath:async()=>({hostPath:'/files/a.exe',workspaceRoot:'/files',version:'v1',size:1})};
 await assert.rejects(ingestFile({service,files,ctx:{workspace:'w'},grantId:'g1',path:'a.exe',baseId:BASE}),/Unsupported knowledge file type/,'必须转达宿主给出的原因，不自行解释');
});

test('the browser path ingests for the operator and still reports both stages',async() => {
 const {browserRoute}=await import('../src/browser-api.mjs');
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const seed=store.draft(ctx,{title:'材料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'纪要',path:'meetings/a.md',fileGrantId:'g1',fileVersion:'v1',content:'原文'}}]});
 store.commit(ctx,{batchId:seed.id,revision:1,key:'k'});
 const imported=[];
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],files:{hostPath:async(ctx,{grantId,path})=>{imported.push({grantId,path});return {hostPath:'/files/'+path,workspaceRoot:'/files',version:'v1',size:3}}},
  knowledge:{service:{importFileFromPath:async()=>({id:'d7',status:'processing'}),listDocuments:async()=>[{id:'d7',status:'processing'}]},grants:[{workspace:'w',baseId:'base-1'}],search:async()=>({hits:[]})}});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const result=await call({action:'knowledge_ingest',id:'a1',baseId:'base-1'});
  assert.deepEqual(imported,[{grantId:'g1',path:'meetings/a.md'}]);
  assert.equal(result.staged[0].ok,true);
  assert.equal(result.staged[0].status,'processing');
  const record=result.staged.find(step=>step.stage==='record');
  assert.equal(record.ok,true);
  assert.match(record.note,/同意后写进工作台/,'必须说明还需要用户确认');
  const status=await call({action:'knowledge_status',id:'a1'});
  assert.equal(status.available,false,'待确认的改动未确认前记录里还没有知识库归属，状态应如实不可用');
  assert.match(status.reason,/未记录知识库归属/);
 }finally{store.close()}
});
test('the browser path refuses an unauthorized base before importing',async() => {
 const {browserRoute}=await import('../src/browser-api.mjs');
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 let imported=0;
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],files:{hostPath:async()=>({hostPath:'/files/a.md'})},
  knowledge:{service:{importFileFromPath:async()=>{imported+=1;return {id:'d',status:'processing'}}},grants:[{workspace:'w',baseId:'other'}],search:async()=>({hits:[]})}});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const result=await call({action:'knowledge_ingest',id:'missing',baseId:'base-1'});
  assert.equal(result.error,'FORBIDDEN');
  assert.equal(imported,0);
 }finally{store.close()}
});

test('the detail line states the real indexing phase instead of a generic claim',async() => {
 const {knowledgeStateLine}=await import('../prototype/record-detail.mjs');
 assert.match(knowledgeStateLine({available:true,status:'processing',progress:42}),/知识库：正在处理（进度 42%）/);
 assert.match(knowledgeStateLine({available:true,status:'ready',chunkCount:12}),/知识库：已存好（片段 12）/);
 assert.match(knowledgeStateLine({available:true,status:'failed',message:'嵌入模型不可用'}),/知识库：失败（嵌入模型不可用）/);
 assert.match(knowledgeStateLine({available:true,status:'not-found'}),/该文档已不存在/);
 assert.match(knowledgeStateLine({available:true,status:'unknown',rawStatus:'weird'}),/无法确认（宿主状态 weird）/,'未知状态要原样显示');
 assert.match(knowledgeStateLine({available:false,reason:'未记录知识库归属'}),/未记录知识库归属/);
 assert.doesNotMatch(knowledgeStateLine({available:true,status:'processing'}),/已完成/,'检索中不得显示成已完成');
});test('the artifact detail shows the indexing state and hides re-ingest while it is working',async () => {
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const {JSDOM}=await import('../dev-deps.mjs');
 const {readFileSync}=await import('node:fs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const item={id:'a1',kind:'artifact',revision:1,archived:false,data:{title:'纪要',path:'meetings/a.md',fileGrantId:'g1',fileVersion:'v1',knowledgeBaseId:'base-1',knowledgeDocId:'d1'}};
 const send=async action=>{
  if(action==='get')return {item};
  if(action==='artifact_state')return {status:'current',version:'v1'};
  if(action==='knowledge_status')return {available:true,status:'processing',progress:42};
  if(action==='knowledge_bases')return {items:[{id:'base-1',title:'工作资料'}]};
  throw Error(action)};
 const detail=createRecordDetail(document,send,{notify:()=>{}});
 try{
  await detail.open('a1');
  for(let index=0;index<8;index+=1)await new Promise(resolve=>setImmediate(resolve));
  const state=document.querySelector('#detailbody [data-knowledge-state]');
  assert(state,'资料详情必须显示存进知识库状态');
  assert.match(state.textContent,/知识库：正在处理（进度 42%）/);
  assert(!document.querySelector('#detailbody [data-knowledge-actions] button'),'检索进行中不应提供重复存进知识库入口');
 }finally{detail.dispose();dom.window.close()}
});
test('a failed ingest offers a retry that re-runs both stages and opens the draft',async () => {
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const {JSDOM}=await import('../dev-deps.mjs');
 const {readFileSync}=await import('node:fs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const calls=[];
 const item={id:'a1',kind:'artifact',revision:1,archived:false,data:{title:'纪要',path:'meetings/a.md',fileGrantId:'g1',fileVersion:'v1',knowledgeBaseId:'base-1',knowledgeDocId:'d1'}};
 const send=async(action,data)=>{calls.push({action,data});
  if(action==='get')return {item};
  if(action==='artifact_state')return {status:'current',version:'v1'};
  if(action==='knowledge_status')return {available:true,status:'failed',message:'嵌入模型不可用'};
  if(action==='knowledge_bases')return {items:[{id:'base-1',title:'工作资料'}]};
  if(action==='knowledge_ingest')return {available:true,staged:[{stage:'ingest',ok:true,status:'processing',baseId:'base-1',documentId:'d1'},{stage:'record',ok:true,batchId:'b9',note:'已生成待确认的改动，确认后写入记录'}]};
  throw Error(action)};
 let opened=null;
 const detail=createRecordDetail(document,send,{notify:()=>{},openBatch:id=>{opened=id}});
 try{
  await detail.open('a1');
  for(let index=0;index<8;index+=1)await new Promise(resolve=>setImmediate(resolve));
  assert.match(document.querySelector('#detailbody [data-knowledge-state]').textContent,/知识库：失败（嵌入模型不可用）/);
  const button=document.querySelector('#detailbody [data-knowledge-actions] button');
  assert(button,'失败后必须提供重新存进知识库入口');
  assert.match(button.textContent,/重新存进知识库/);
  button.click();
  for(let index=0;index<6;index+=1)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened,'b9','存进知识库后应打开待确认的改动让用户确认');
  assert(calls.some(call=>call.action==='knowledge_ingest'&&call.data.baseId==='base-1'));
 }finally{detail.dispose();dom.window.close()}
});
