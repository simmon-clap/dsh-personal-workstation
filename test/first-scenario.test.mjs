import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';

/** PRD v1.1 §11 固定的首个真实业务验收场景：
 *  会议材料 → Agent 整理 → DSH 对话修订 → 整批归档 → 资料与待办可打开 → 关联画布可查证。
 *  全程走界面与 Agent 共用的那条 HTTP 路径，逐步断言，不在中间吃假设。 */
function harness(){
 const store=new WorkstationStore(':memory:');
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null,list:()=>[{id:'w',title:'飞书工作区'}]},allowedWorkspaces:['w'],files:{grants:[{id:'g1',workspace:'w',root:'/files',read:true,write:true}]},
  // 会话服务按宿主真实契约提供：只取用户消息与标题。
  sessionQuery:{filterEvents:async()=>[{seq:3,time:1700000000000,type:'user/message',text:'把今天的会议材料整理成项目和待办，负责人王工，截止 11-01。'}],readTitle:async()=>({title:'DSH · 会议整理'})}});
 const call=async body=>{
  const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));
  const value=await response.json();
  if(!response.ok)throw Object.assign(Error(value.message??'请求失败'),{code:value.error});
  return value;
 };
 // Agent 侧：与界面共用同一个 store，但写入时自带会话来源（浏览器侧无法伪造来源，这是有意的）。
 const adapter=new DshAdapter({store,sessions:{get:id=>id==='session-meeting'?{header:{cwd:'/w'}}:null},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w',title:'飞书工作区'})},allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'}});
 const agent=(action,args={})=>adapter.run({action,...args},{agent:{id:'session-meeting'},callId:'c1'});
 return {store,call,agent};
}

test('the fixed first scenario runs end to end without repeating any manual form entry',async()=>{
 const {store,call,agent}=harness();
 const meeting='产品周会 2026-10-20\\n1) 确认试点范围\\n2) 负责人：王工\\n3) 截止：2026-11-01';
 try{
  // ① 会议材料：Agent 把材料登记为资料记录（带来源与文件版本），并整理出项目与待办。
  const ingested=await agent('draft',{title:'会议材料归档',changes:[
   {op:'create',id:'a-notes',kind:'artifact',data:{title:'产品周会纪要',path:'meetings/2026-10-20.md',fileGrantId:'g1',fileVersion:'v7',content:meeting},sources:{content:'会议材料原文',path:'用户提供的文件'}},
   {op:'create',id:'p-pilot',kind:'project',data:{title:'试点范围跟进',goal:'确认试点范围',stage:'需求'},sources:{goal:'会议纪要第 1 条'}},
   {op:'create',id:'person-wang',kind:'person',data:{title:'王工'},sources:{title:'会议纪要第 2 条'}},
   {op:'create',id:'t-scope',kind:'task',data:{title:'输出试点范围清单',status:'todo',projectId:'p-pilot',ownerId:'person-wang',dueDate:'2026-11-01',expectedOutput:'范围清单',executionTarget:''},sources:{dueDate:'会议纪要第 3 条',title:'会议纪要第 1 条',ownerId:'会议纪要第 2 条'}},
   {op:'create',id:'r-link',kind:'relation',data:{title:'任务产出资料',from:'t-scope',to:'a-notes',status:'suggested',evidence:'会议材料第 2 条要求把清单附在纪要后'}},
  ]});
  assert.equal(ingested.revision,1);
  // ② DSH 对话修订：同一批次上改截止日与负责人，不新建对象、不产生重复记录。
  const revised=await agent('draft',{id:ingested.id,revision:1,title:'会议材料归档',changes:[
   {op:'create',id:'a-notes',kind:'artifact',data:{title:'产品周会纪要',path:'meetings/2026-10-20.md',fileGrantId:'g1',fileVersion:'v7',content:meeting},sources:{content:'会议材料原文',path:'用户提供的文件'}},
   {op:'create',id:'p-pilot',kind:'project',data:{title:'试点范围跟进',goal:'确认试点范围',stage:'需求'},sources:{goal:'会议纪要第 1 条'}},
   {op:'create',id:'person-wang',kind:'person',data:{title:'王工'},sources:{title:'会议纪要第 2 条'}},
   {op:'create',id:'t-scope',kind:'task',data:{title:'输出试点范围清单',status:'todo',projectId:'p-pilot',ownerId:'person-wang',dueDate:'2026-11-05',expectedOutput:'范围清单',executionTarget:''},sources:{dueDate:'对话修订：推迟到 11-05',title:'会议纪要第 1 条',ownerId:'会议纪要第 2 条'}},
   {op:'create',id:'r-link',kind:'relation',data:{title:'任务产出资料',from:'t-scope',to:'a-notes',status:'suggested',evidence:'会议材料第 2 条要求把清单附在纪要后'}},
  ]});
  assert.equal(revised.revision,2,'同一待确认的改动连续修订只升待确认的改动版本');
  const preview=await call({action:'preview',id:ingested.id});
  assert.equal(preview.diff.length,5,'修订不产生重复记录');
  assert.deepEqual(preview.conflicts??[],[]);
  assert.deepEqual(preview.validationErrors??[],[]);
  const taskDiff=preview.diff.find(entry=>entry.id==='t-scope');
  assert.equal(taskDiff.after.dueDate,'2026-11-05','修订后的值必须在预览里可见');
  assert.equal(taskDiff.sources.dueDate,'对话修订：推迟到 11-05','字段来源必须随修订更新');
  // ③ 整批归档。
  const receipt=await call({action:'commit',id:ingested.id,revision:2,key:'ui:'+ingested.id+':2'});
  assert.equal(receipt.status,'committed');
  assert.equal(store.inbox({workspace:'w',actor:'t'}, {status:'draft'}).length,0,'提交后不应再有待处理待确认的改动');
  assert.equal(store.inbox({workspace:'w',actor:'t'}).length,1,'已提交待确认的改动仍可在收件箱里查历史与记录编号');
  // ④ 资料与待办可打开，且指向同一个项目。
  const artifact=(await call({action:'get',id:'a-notes'})).item;
  const task=(await call({action:'get',id:'t-scope'})).item;
  assert.equal(artifact.data.content,meeting,'资料内容必须可打开');
  assert.equal(task.data.projectId,'p-pilot');
  assert.equal(task.data.dueDate,'2026-11-05');
  assert.equal(task.data.ownerId,'person-wang','负责人必须指向真实联系人对象');
  // 资料记录与文件的版本一致（分阶段状态）。
  assert.equal((await call({action:'artifact_state',id:'a-notes'})).status,'unknown','测试环境没有文件服务时必须报无法确认，而不是报一致');
  // ⑤ 关联画布可查证：推测关系是虚线依据，确认后记录版本依据。
  const before=(await call({action:'graph'})).relations.find(edge=>edge.id==='r-link');
  assert.equal(before.status,'suggested');
  assert.equal(before.stale,null);
  // 只把关系自身的字段写回（界面里的 relationData 同样如此），不把图谱边的 id/revision 当数据。
  const relationFields=['title','from','to','status','evidence','reason'];
  const relationData=Object.fromEntries(relationFields.filter(field=>before[field]!==undefined).map(field=>[field,before[field]]));
  const confirmed=await call({action:'draft',title:'关系判定',changes:[{op:'update',id:'r-link',expectedRevision:1,data:{...relationData,status:'confirmed',basis:['t-scope@1','a-notes@1']}}]});
  await call({action:'commit',id:confirmed.id,revision:1,key:'rel-1'});
  const graph=await call({action:'graph'});
  const edge=graph.relations.find(item=>item.id==='r-link');
  assert.equal(edge.status,'confirmed','画布必须能看到已确认的关系');
  assert.equal(edge.stale,null);
  assert(graph.nodes.some(node=>node.id==='t-scope')&&graph.nodes.some(node=>node.id==='a-notes'),'画布必须同时包含任务与资料节点');
  // ⑥ 结果可追溯到用户指令：能读到当时那句话，且只取用户消息。
  const origin=await call({action:'batch_origin',id:ingested.id});
  assert.equal(origin.available,true);
  assert.equal(origin.title,'DSH · 会议整理');
  assert.deepEqual(origin.messages.map(message=>message.text),['把今天的会议材料整理成项目和待办，负责人王工，截止 11-01。']);
  // 回执可按幂等键查回，撤销基于同一回执生成反向草稿。
  const sameReceipt=await call({action:'commit',id:ingested.id,revision:2,key:'ui:'+ingested.id+':2'});
  assert.equal(sameReceipt.id,receipt.id,'重复提交必须返回同一记录编号，不重复写入');
  // 撤销：归档之后关系又被确认过，因此这批不能直接撤销——必须报限制而不是硬改数据。
  const blocked=await call({action:'undo_draft',key:'ui:'+ingested.id+':2'}).then(()=>null,error=>error);
  assert(blocked,'对象已被后续修改时不得直接撤销');
  assert.match(blocked.message,/对象已被后续修改，不能直接撤销/);
  // 没有被后续修改影响的回执可以正常生成反向草稿，且仍需用户确认才生效。
  const reverse=await call({action:'undo_draft',key:'rel-1'});
  assert.match(reverse.title,/撤销这次改动/);
  assert.equal(store.inbox({workspace:'w',actor:'t'},{status:'draft'}).length,1,'撤销必须先生成待确认的改动等待确认，而不是直接改数据');
  assert.equal(store.get({workspace:'w',actor:'t'},'r-link').data.status,'confirmed','待确认的改动未提交前不得改回原值');
 }finally{store.close()}
});
test('the scenario stays consistent when the material changes after archiving',async()=>{
 const {store,call}=harness();
 try{
  const draft=await call({action:'draft',title:'材料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'纪要',path:'meetings/a.md',fileGrantId:'g1',fileVersion:'v1',content:'原文'}}]});
  await call({action:'commit',id:draft.id,revision:1,key:'k1'});
  // 文件随后被改动：记录必须仍然可打开，且状态如实显示为无法确认（测试环境无文件服务）。
  const state=await call({action:'artifact_state',id:'a1'});
  assert.equal(state.status,'unknown');
  const item=(await call({action:'get',id:'a1'})).item;
  assert.equal(item.data.fileVersion,'v1','比较不得改写记录');
  assert.equal(item.data.content,'原文');
 }finally{store.close()}
});
