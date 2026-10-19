/** 生成视图 v1 的服务端底座（spec/18 §3 / §5 / §6；spec/27 §4 G1/G2）。
 *
 *  这里守的是四件事：
 *  ① 四个模板都**只能从真实对象**构造：view 的每条 dataRefs 都指回 store 里真实、未归档的对象；
 *  ② 契约硬约束真的会红：未知模板 / 参数越界 / 无 basis / dataRefs 超过 50 条 / 引用不可用；
 *  ③ stale 与 relationStale 同一套口径：引用的 revision 变了 → stale，用户看到"依据已变"；
 *  ④ 保存只走 draft（收件箱确认），落库的是**定义**（没有 content 渲染快照），且不进画布/搜索。
 *
 *  不使用夹具数据冒充真实用户行为：这里的对象是本测试自己建的最小真实记录（store 落库路径），
 *  断言的是"服务端如何从真实对象推导 view"，不是某一次真实会话的产物。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {buildViewPreview,saveViewDraft,validateViewDefinition,computeStale,normalizeDataRefs,normalizeBasis,VIEW_TEMPLATES} from '../src/view-spec.mjs';
import {graph,searchNodes} from '../src/graph.mjs';
import {browserRoute} from '../src/browser-api.mjs';

const ctx={workspace:'test',actor:'tester',canWrite:true};
const NOW=new Date(2026,9,18,13,40,0);

function seed(store,changes,key){
 const batch=store.draft(ctx,{title:key,changes});
 return store.commit(ctx,{batchId:batch.id,revision:1,key:key+'-'+Math.random()});
}
function fixture(){
 const store=new WorkstationStore(':memory:');
 seed(store,[
  {op:'create',id:'p',kind:'project',data:{title:'项目A',goal:'验证一件事',stage:'验证',dueDate:'2026-10-01'}},
  {op:'create',id:'p-empty',kind:'project',data:{title:'空项目'}},
 ],'fixture-project');
 seed(store,[
  {op:'create',id:'t1',kind:'task',data:{title:'等对方给材料',projectId:'p',status:'waiting',blockedReason:'对方还没回邮件',dueDate:'2026-10-20',dependsOn:['t2']}},
  {op:'create',id:'t2',kind:'task',data:{title:'先拿到样例',projectId:'p',status:'todo',dueDate:'2026-10-19'}},
 ],'fixture-task');
 seed(store,[
  {op:'create',id:'j1',kind:'judgment',data:{title:'对方排期只是口述',projectId:'p',status:'checking',validFrom:'2026-10-11',uncertainty:'只有口述',evidence:[{kind:'file',ref:'art-1@2',quote:'会议纪要原文',verified:false}]}},
  {op:'create',id:'j2',kind:'judgment',data:{title:'对方主体已经确认',projectId:'p',status:'current',validFrom:'2026-10-12',evidence:[{kind:'note',ref:'user-1',quote:'用户确认主体',verified:true}]}},
  {op:'create',id:'j3',kind:'judgment',data:{title:'（已被推翻）最初的主体判断',projectId:'p',status:'overturned',validFrom:'2026-10-10',evidence:[{kind:'note',ref:'user-2',quote:'当时按文件名推断',verified:false}],overturnedBy:{reason:'用户确认主体不是这个',ref:'user-3',at:'2026-10-11T00:00:00.000Z'}}},
 ],'fixture-judgment');
 seed(store,[
  {op:'create',id:'art-1',kind:'artifact',data:{title:'会议纪要.md',path:'纪要.md',fileGrantId:'grant-1',mime:'text/markdown',projectId:'p',taskIds:['t1']}},
  {op:'create',id:'topic-1',kind:'topic',data:{title:'议题一',content:'讨论记录：先把样例拿到'}},
 ],'fixture-material');
 return {store};
}
function preview(store,args){return buildViewPreview({store,ctx,now:NOW,...args});}
function definitionOf(view){const {content,kind,...definition}=view;return definition;}

test('四个模板都从真实对象生成 view v1：字段、引用、依据与模板内容齐全',()=>{
 const {store}=fixture();
 try{
  assert.deepEqual(VIEW_TEMPLATES,['risk-matrix','timeline','compare-table','blocker']);
  const risk=preview(store,{template:'risk-matrix',subjectId:'p'});
  assert.equal(risk.kind,'view');
  assert.equal(risk.template,'risk-matrix');
  assert.deepEqual(risk.subject,{id:'p',kind:'project',revision:1});
  assert.ok(risk.dataRefs.length>0&&risk.dataRefs.length<=50,'dataRefs 必须在 1–50 条');
  assert.ok(risk.dataRefs.includes('p@1'),'subject 必须在 dataRefs 里');
  assert.ok(risk.basis.length>=1,'至少一条依据');
  assert.match(risk.generatedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(risk.origin,'ai');
  assert.equal(risk.state,'fresh');
  assert.ok(risk.actions.length>0&&risk.actions.length<=3);
  assert.ok(risk.content.rows.length>=1,'至少要有一条风险行');
  assert.equal(risk.content.counts.total,risk.content.rows.length);
  for(const row of risk.content.rows){
   assert.ok(['high','medium','low'].includes(row.risk));
   assert.ok(row.refs.length>=1&&row.refs.every(ref=>risk.dataRefs.includes(ref)),'风险行的出处必须在 dataRefs 里：'+row.id);
  }
  // 只有真实对象才进结果：推翻的判断 = 高风险；在等的任务/过期项目截止也在。
  assert.ok(risk.content.rows.some(row=>row.id==='j3'&&row.risk==='high'),'被推翻的判断应当是高风险的来源之一');
  assert.ok(risk.content.rows.some(row=>row.id==='t1'&&row.risk==='high'),'记录了阻塞的任务应当进入风险矩阵');

  const timeline=preview(store,{template:'timeline',subjectId:'p'});
  assert.equal(timeline.template,'timeline');
  assert.ok(timeline.content.items.length>=3);
  const dates=timeline.content.items.map(item=>item.at);
  assert.deepEqual(dates,[...dates].sort(),'时间线必须按时间升序');
  assert.ok(timeline.content.items.some(item=>item.waiting===true),'时间线要标出哪一步在等');
  for(const item of timeline.content.items)assert.ok(item.refs.every(ref=>timeline.dataRefs.includes(ref)));

  const compare=preview(store,{template:'compare-table',params:{subjectIds:['j1','j2']}});
  assert.equal(compare.template,'compare-table');
  assert.equal(compare.subject.id,'j1','对比以第一个对象为锚点，全部来源在 params.subjectIds');
  assert.deepEqual(compare.content.sources.map(source=>source.id),['j1','j2']);
  assert.equal(compare.content.matrix.length,compare.content.dimensions.length);
  const statusCell=compare.content.matrix.find(row=>row.id==='status').cells;
  assert.equal(statusCell[0].status,'diff','待核对与当前有效是明确分歧');
  assert.equal(compare.content.matrix.find(row=>row.id==='verified').cells[0].status,'diff','一条经第三方验证、一条没有 = 分歧');
  assert.equal(compare.content.agreement.diff+compare.content.agreement.same+compare.content.agreement.missing+compare.content.agreement.unrated,compare.content.dimensions.length);

  const blocker=preview(store,{template:'blocker',subjectId:'t1'});
  assert.equal(blocker.template,'blocker');
  assert.equal(blocker.subject.kind,'task');
  assert.ok(blocker.content.chain.length>=2,'阻塞链至少包含任务本身与未完成的依赖');
  assert.ok(blocker.content.waitingOn.length>=1,'要能看出在等谁/等哪个对象');
  assert.ok(blocker.content.nextSteps.length>=1&&blocker.content.nextSteps.length<=3,'下一步最多 3 条');
  assert.ok(blocker.actions.length<=3);
 }finally{store.close()}
});

test('未知模板一律拒绝（INVALID），不降级不猜',()=>{
 const {store}=fixture();
 try{
  assert.throws(()=>preview(store,{template:'mood-board',subjectId:'p'}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'',subjectId:'p'}),{code:'INVALID'});
 }finally{store.close()}
});

test('模板参数越界 / 未知参数拒绝（INVALID）',()=>{
 const {store}=fixture();
 try{
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'p',params:{horizonDays:0}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'p',params:{horizonDays:3.5}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'p',params:{horizonDays:99999}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'p',params:{foo:1}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'timeline',subjectId:'p',params:{horizonDays:1}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'blocker',subjectId:'t1',params:{subjectIds:['a','b']}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'compare-table',params:{subjectIds:['j1']}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'compare-table',params:{subjectIds:['j1','j2','j3','topic-1']}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'compare-table',params:{subjectIds:['j1','j1']}}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'compare-table',params:{subjectIds:['j1','j2'],dimensions:['mood']}}),{code:'INVALID'});
  // 模板用错对象类型也是 INVALID（不是引用不可用）
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'t1'}),{code:'INVALID'});
  assert.throws(()=>preview(store,{template:'blocker',subjectId:'p'}),{code:'INVALID'});
 }finally{store.close()}
});

test('引用不可用 → REFERENCE（不编造对象、不静默降级）',()=>{
 const {store}=fixture();
 try{
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'ghost'}),{code:'REFERENCE'});
  assert.throws(()=>preview(store,{template:'compare-table',params:{subjectIds:['j1','ghost']}}),{code:'REFERENCE'});
 }finally{store.close()}
});

test('没有真实数据 → UNAVAILABLE（一句人话，不是空数组冒充结果）',()=>{
 const {store}=fixture();
 try{
  assert.throws(()=>preview(store,{template:'risk-matrix',subjectId:'p-empty'}),{code:'UNAVAILABLE'});
  // 没有阻塞、没有未完成依赖、没有过期：不硬造阻塞链。
  seed(store,[{op:'create',id:'t-clean',kind:'task',data:{title:'一个正常任务',projectId:'p'}}],'fixture-clean-task');
  assert.throws(()=>preview(store,{template:'blocker',subjectId:'t-clean'}),{code:'UNAVAILABLE'});
 }finally{store.close()}
});

test('无 basis 拒绝（INVALID）：校验与写路径都挡',()=>{
 const {store}=fixture();
 try{
  const view=preview(store,{template:'risk-matrix',subjectId:'p'});
  const definition=definitionOf(view);
  assert.throws(()=>validateViewDefinition({...definition,basis:[]}),{code:'INVALID'});
  const batch=store.draft(ctx,{title:'无依据视图',changes:[{op:'create',kind:'view',data:{...definition,basis:[]}}]});
  const inspected=store.preview(ctx,batch.id);
  assert.equal(inspected.validationErrors.length,1);
  assert.equal(inspected.validationErrors[0].code,'INVALID');
  assert.throws(()=>store.commit(ctx,{batchId:batch.id,revision:1,key:'no-basis'}),{code:'INVALID'});
  assert.equal(store.list(ctx,{kind:'view'}).length,0);
 }finally{store.close()}
});

test('dataRefs 超过 50 条拒绝（INVALID），生成侧自行收口到 ≤50',()=>{
 const {store}=fixture();
 try{
  const view=preview(store,{template:'risk-matrix',subjectId:'p'});
  const definition=definitionOf(view);
  const tooMany=['p@1',...Array.from({length:50},(_,index)=>'ghost-'+index+'@1')];
  assert.equal(tooMany.length,51);
  assert.throws(()=>validateViewDefinition({...definition,dataRefs:tooMany}),{code:'INVALID'});
  assert.throws(()=>normalizeDataRefs(tooMany),{code:'INVALID'});

  // 生成侧：60 个在等任务也不能让 dataRefs 超过 50（超出上限的行宁可不显示，不突破契约）。
  const changes=Array.from({length:60},(_,index)=>({op:'create',id:'busy-'+index,kind:'task',data:{title:'堆积任务 '+index,projectId:'p',status:'waiting',blockedReason:'都在等同一个回复'}}));
  seed(store,changes,'fixture-busy');
  const crowded=preview(store,{template:'risk-matrix',subjectId:'p'});
  assert.ok(crowded.dataRefs.length<=50,'生成结果的 dataRefs 必须 ≤50：'+crowded.dataRefs.length);
  assert.ok(crowded.basis.length<=50);
 }finally{store.close()}
});

test('stale 判定：引用 revision 变化 / 归档 / 消失 → stale；无关对象变化仍 fresh',()=>{
 const {store}=fixture();
 try{
  assert.deepEqual(computeStale(['p@1'],id=>store.get(ctx,id)),{state:'fresh',changed:[]});
  const changed=computeStale(['p@1'],()=>({id:'p',revision:2,archived:false}));
  assert.equal(changed.state,'stale');
  assert.equal(changed.changed[0].expectedRevision,1);
  assert.equal(changed.changed[0].currentRevision,2);
  assert.equal(computeStale(['p@1'],()=>null).state,'stale');
  assert.equal(computeStale(['p@1'],()=>({id:'p',revision:1,archived:true})).state,'stale');
  assert.equal(computeStale(['not-a-ref'],()=>null).state,'stale');

  // 集成：保存后引用对象被更新 → 重新打开显示 stale（不是静默刷新）。
  const view=preview(store,{template:'risk-matrix',subjectId:'p'});
  const {batch}=saveViewDraft({store,ctx,view,idFactory:()=>'view-target-id'});
  store.commit(ctx,{batchId:batch.id,revision:1,key:'stale-save'});
  const viewId=batch.changes.find(change=>change.kind==='view').id;
  assert.equal(buildViewPreview({store,ctx,viewId,now:NOW}).state,'fresh');
  // 只改**不在 dataRefs 里**的对象 → 仍 fresh（stale 只跟被引用的对象有关，不是任何数据一变就报）。
  seed(store,[{op:'update',id:'topic-1',expectedRevision:1,data:{title:'议题一',content:'更新后的讨论记录'}}],'fixture-update-topic');
  assert.equal(buildViewPreview({store,ctx,viewId,now:NOW}).state,'fresh','未被引用的对象变化不该标 stale');
  // 被引用的项目 revision 变了 → stale，并且定义（引用 / 生成时间）不变。
  seed(store,[{op:'update',id:'p',expectedRevision:1,data:{title:'项目A',goal:'目标更新',stage:'验证',dueDate:'2026-10-01'}}],'fixture-update-project');
  const reopened=buildViewPreview({store,ctx,viewId,now:NOW});
  assert.equal(reopened.state,'stale','引用对象 revision 变了必须标 stale');
  assert.deepEqual(reopened.dataRefs,view.dataRefs,'打开保存过的视图时，引用仍以保存的定义为准');
  assert.equal(reopened.generatedAt,view.generatedAt,'打开保存过的视图时，定义里的生成时间不变');
 }finally{store.close()}
});

test('保存视图只生成 draft：落库的是定义（无 content），且不进画布/搜索',()=>{
 const {store}=fixture();
 try{
  const view=preview(store,{template:'risk-matrix',subjectId:'p'});
  const {batch,as}=saveViewDraft({store,ctx,view,idFactory:()=>'view-target-id'});
  assert.equal(as,'view');
  assert.equal(batch.status,'draft');
  assert.equal(batch.changes.length,1);
  assert.equal(batch.changes[0].op,'create');
  assert.equal(batch.changes[0].kind,'view');
  assert.equal(batch.changes[0].data.content,undefined,'渲染快照 content 不得落库');
  assert.equal(store.list(ctx,{kind:'view'}).length,0,'draft 不是业务数据');
  assert.equal(store.inbox(ctx,{status:'draft'}).length,1);
  store.commit(ctx,{batchId:batch.id,revision:1,key:'save-view'});
  const saved=store.list(ctx,{kind:'view'})[0];
  assert.equal(saved.kind,'view');
  assert.deepEqual(Object.keys(saved.data).sort(),['actions','basis','dataRefs','generatedAt','origin','params','state','subject','template','title']);
  assert.equal(saved.data.state,'fresh');

  assert.equal(graph(store,ctx,{}).nodes.some(node=>node.kind==='view'),false,'view 不进画布');
  assert.equal(searchNodes(store,ctx,{query:'项目A'}).items.some(item=>item.kind==='view'),false,'view 不进节点搜索');

  // 引用不可用 → REFERENCE；非法定义 → INVALID，都不落库。
  const ghost={...definitionOf(view),dataRefs:['ghost@1'],subject:{id:'ghost',kind:'project',revision:1}};
  assert.throws(()=>saveViewDraft({store,ctx,view:{...view,...ghost},idFactory:()=>'x'}),{code:'REFERENCE'});
  assert.throws(()=>saveViewDraft({store,ctx,view:{...view,state:'broken'},idFactory:()=>'x'}),{code:'INVALID'});
 }finally{store.close()}
});

test('存为判断 / 存为简报：同一 draft 里多一条候选对象，并把 id 记进 savedAs（仍需确认）',()=>{
 const {store}=fixture();
 try{
  const view=preview(store,{template:'risk-matrix',subjectId:'p'});
  const asJudgment=saveViewDraft({store,ctx,view,as:'judgment',idFactory:()=>'judgment-target'});
  assert.equal(asJudgment.as,'judgment');
  assert.equal(asJudgment.batch.changes.length,2);
  assert.equal(asJudgment.batch.changes[0].kind,'judgment');
  assert.equal(asJudgment.batch.changes[0].data.status,'checking');
  assert.equal(asJudgment.batch.changes[0].data.validFrom,NOW.getFullYear()+'-'+String(NOW.getMonth()+1).padStart(2,'0')+'-'+String(NOW.getDate()).padStart(2,'0'));
  assert.ok(asJudgment.batch.changes[0].data.evidence.length>=1);
  assert.equal(asJudgment.batch.changes[1].data.savedAs,'judgment-target');
  store.commit(ctx,{batchId:asJudgment.batch.id,revision:1,key:'save-as-judgment'});
  const viewRow=store.list(ctx,{kind:'view'}).find(row=>row.data.savedAs==='judgment-target');
  assert.ok(viewRow,'savedAs 必须指回新建的判断');
  assert.ok(store.list(ctx,{kind:'judgment'}).some(row=>row.id==='judgment-target'));

  const asBrief=saveViewDraft({store,ctx,view,as:'brief',idFactory:()=>'brief-target'});
  assert.equal(asBrief.batch.changes[0].kind,'brief');
  assert.match(asBrief.batch.changes[0].data.source,/生成视图/);
  assert.throws(()=>saveViewDraft({store,ctx,view,as:'poem'}),{code:'INVALID'});
 }finally{store.close()}
});

test('浏览器 API：view_preview 只读、view_save 只落 draft；错误码经 HTTP 语义返回',async()=>{
 const {store}=fixture();
 try{
  const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='test'?{id}:null,list:()=>[{id:'test'}]},allowedWorkspaces:['test']});
  const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'x-workstation-client':'1'},body:JSON.stringify({workspace:'test',...body})}));return {status:response.status,body:await response.json()};};
  const previewResponse=await call({action:'view_preview',template:'risk-matrix',subjectId:'p'});
  assert.equal(previewResponse.status,200);
  assert.equal(previewResponse.body.view.template,'risk-matrix');
  assert.equal(store.list(ctx,{kind:'view'}).length,0,'预览不得落库');
  const saveResponse=await call({action:'view_save',view:previewResponse.body.view});
  assert.equal(saveResponse.status,200);
  assert.equal(saveResponse.body.as,'view');
  assert.equal(saveResponse.body.batch.status,'draft');
  assert.equal(store.list(ctx,{kind:'view'}).length,0,'view_save 不得直接 commit');
  assert.equal((await call({action:'view_preview',template:'nope',subjectId:'p'})).status,400);
  assert.equal((await call({action:'view_preview',template:'risk-matrix',subjectId:'ghost'})).status,400);
  assert.equal((await call({action:'view_preview',template:'risk-matrix',subjectId:'p-empty'})).status,503);
 }finally{store.close()}
});

test('保存路径只依赖 store 的最小只读/草稿子集（可被最小 mock 驱动）',()=>{
 const view={
  kind:'view',title:'示例 · 风险与证据',template:'risk-matrix',
  subject:{id:'p',kind:'project',revision:1},
  params:{horizonDays:90},
  dataRefs:['p@1'],
  basis:[{kind:'note',ref:'p@1',quote:'项目当前阶段'}],
  generatedAt:'2026-10-18T13:40:00+08:00',origin:'ai',state:'fresh',
  actions:['open-subject','save-as-judgment','save-as-brief'],
  content:{template:'risk-matrix',rows:[]},
 };
 const savedCalls=[];
 const fakeStore={
  get:(_ctx,id)=>(id==='p'?{id:'p',kind:'project',revision:1,archived:false,data:{title:'项目'}}:null),
  writeDraft:(_ctx,input,_id)=>{savedCalls.push(input);return {id:'batch-1',status:'draft',revision:1,changes:input.changes};},
 };
 const {batch}=saveViewDraft({store:fakeStore,ctx,view,idFactory:()=>'target-1'});
 assert.equal(batch.id,'batch-1');
 assert.equal(savedCalls.length,1);
 assert.equal(savedCalls[0].changes[0].kind,'view');
 assert.equal(savedCalls[0].changes[0].data.content,undefined);
 assert.equal(normalizeBasis(view.basis).length,1);
});
