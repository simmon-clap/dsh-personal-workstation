import {test} from 'node:test';import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {ExecutionRunner} from '../src/execution-runner.mjs';
import {canonicalWav} from './helpers/wav.mjs';

/**
 * 宿主对 `workstation` 工具的返回值做**无损 JSON**快照：任何嵌套的 `undefined`、非有限数、
 * BigInt / function / symbol、稀疏数组、循环引用或 class 实例，都会让宿主报
 * `tool "workstation" returned invalid output: value is not lossless JSON` 并拒收**整次调用**
 * （preview 曾经就这样被整批拒掉：diff 里的 `archivedData: undefined`）。
 *
 * 这里把"返回值必须无损 JSON"固化成常规回归：在**适配器真实边界**（`adapter.run`，也就是宿主
 * 实际拿到的东西）上逐 action 检查，而不是只测 store 内部方法。判定器与宿主 `snapshotJsonValue`
 * 同语义，再叠一层 `JSON.parse(JSON.stringify(x))` 深度相等——后者专门抓 `{key: undefined}`
 * 这种从字符串上看不出来的情况（`JSON.stringify` 会静默丢键）。
 */
function isLossless(value){
 const ancestors=new Set();const stack=[value];
 while(stack.length){
  const current=stack.pop();
  if(current===null||typeof current==='string'||typeof current==='boolean')continue;
  if(typeof current==='number'){if(!Number.isFinite(current)||Object.is(current,-0))return false;continue}
  if(typeof current!=='object')return false;
  if(ancestors.has(current))return false;
  ancestors.add(current);
  if(Array.isArray(current)){
   if(Object.getPrototypeOf(current)!==Array.prototype)return false;
   if(Reflect.ownKeys(current).length!==current.length+1)return false; // 稀疏数组
   for(let index=0;index<current.length;index++){if(!Object.hasOwn(current,index))return false;stack.push(current[index])}
   ancestors.delete(current);continue;
  }
  const prototype=Object.getPrototypeOf(current);
  if(prototype!==Object.prototype&&prototype!==null)return false; // class 实例 / Date / Map…
  for(const key of Reflect.ownKeys(current)){
   if(typeof key!=='string')return false;
   const descriptor=Object.getOwnPropertyDescriptor(current,key);
   if(descriptor?.enumerable!==true)return false;
   stack.push(Reflect.get(current,key));
  }
  ancestors.delete(current);
 }
 return true;
}
/** 逐字段列出会被宿主拒收的值，失败信息直接指出是哪个字段。 */
function offenders(value,path='value',out=[]){
 if(value===undefined){out.push(path+' = undefined');return out}
 if(typeof value==='number'&&!Number.isFinite(value)){out.push(path+' = '+value);return out}
 if(typeof value==='bigint'||typeof value==='function'||typeof value==='symbol'){out.push(path+' = '+typeof value);return out}
 if(value===null||typeof value!=='object')return out;
 if(Array.isArray(value)){value.forEach((item,index)=>offenders(item,path+'['+index+']',out));return out}
 for(const [key,item] of Object.entries(value))offenders(item,path+'.'+key,out);
 return out;
}
/**
 * JSON 看得见的东西：对象的键（含值为 undefined 的键）、原始值、数组长度。
 * JSON **看不见**原型——宿主自己也接受 null 原型记录（`hasPlainObjectPrototype` 允许
 * `prototype === null`，node:sqlite 的行就是这种），而 `assert.deepStrictEqual` 会比较原型，
 * 直接用会把"能安全过宿主"的值误判成非无损。这里先归一化原型再深度比较，两种误判都能避免。
 */
function toPlain(value){
 if(Array.isArray(value))return value.map(toPlain);
 if(value!==null&&typeof value==='object'){
  const out={};
  for(const key of Reflect.ownKeys(value))out[key]=toPlain(Reflect.get(value,key));
  return out;
 }
 return value;
}
function assertLossless(value,label){
 const found=offenders(value,label);
 assert.deepEqual(found,[],label+'：含宿主会判为非 lossless JSON 的值（'+found.join('、')+'）');
 assert.deepEqual(toPlain(JSON.parse(JSON.stringify(value))),toPlain(value),label+'：JSON 往返后必须与原值深度相等（{key: undefined} 会在这里暴露）');
 assert.equal(isLossless(value),true,label+'：必须通过与宿主 snapshotJsonValue 同语义的判定');
}
async function probe(label,operation){const value=await operation();assertLossless(value,label);return value}

const CWD='/w';
const exec={agent:{id:'s'},callId:'c1',signal:new AbortController().signal};
const speechFillsLanguage={
 // 本机这一版宿主确实会补 language（依据 dsh-experimental-speech-to-text 的 SpeechToText.Config / resolve）。
 resolve(request){if(!request.audio)throw new Error('缺少音频');return {provider:{info:{id:'sensevoice'}},audio:request.audio,language:request.language??'auto'}},
 async transcribe(spec,signal){if(signal?.aborted)throw new Error('aborted');return {text:'会议纪要：确认试点范围。',audioSeconds:12.5,inferenceSeconds:1.4}},
};
const speechOmitsLanguage={
 // 故意模拟"不保证填 language"的宿主：resolve 的返回值里没有 language 键。
 resolve(request){if(!request.audio)throw new Error('缺少音频');return {provider:{info:{id:'sensevoice'}},audio:request.audio}},
 async transcribe(){return {text:'会议纪要：确认试点范围。',audioSeconds:12.5,inferenceSeconds:1.4}},
};
const knowledgeStub={
 grants:[{workspace:'w',baseId:'b1',label:'产品'}],
 service:{
  async listDocuments(){return [{id:'doc-1',status:'indexing',chunkCount:3,progress:40}]},
  async getJob(){return {status:'indexing',progress:40}},
  async importFileFromPath(){return {id:'doc-2',status:'ready',chunkCount:5}},
 },
 async search(ctx,{baseId,query,topK}){return {baseId,query,topK,results:[{documentId:'doc-1',title:'产品手册',score:0.9}]}},
};
const appleStub={async listCalendars(){return ['个人工作台','节假日']}};

function setup({speech=speechFillsLanguage,appleCalendar=null,knowledge=undefined,runner=undefined,executionConfig={enabled:false}}={}){
 const store=new WorkstationStore(':memory:');
 const files={
  // 真实 HostFiles 一定有 grants 数组（构造时给定），runtime_status 会据此统计授权数量。
  grants:[{id:'g1',workspace:'w',root:'/audio',read:true,write:false,label:'会议录音'}],
  async readBinary(ctx,{grantId,path}){
   if(grantId!=='g1'||path.includes('..'))throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});
   const bytes=canonicalWav({seconds:0.4});
   return {bytes,version:'v1',size:bytes.length};
  },
  async hostPath(ctx,{grantId,path}){return {hostPath:'/audio/'+path,size:1234}},
 };
 const adapter=new DshAdapter({
  store,files,knowledge,executions:new ExecutionStore(store),runner,speech,appleCalendar,appleConfig:{targetCalendar:'个人工作台'},
  executionConfig,
  sessions:{get:id=>id==='s'?{header:{cwd:CWD}}:null},
  workspaceRegistry:{resolveByPath:async path=>path===CWD?{id:'w'}:null,get:()=>({id:'w'})},
  allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'},
 });
 return {store,adapter,call:(action,args={})=>adapter.run({action,...args},exec)};
}

test('适配器边界：待确认的改动生命周期（draft/修订/preview/commit/committed/undo/cancel/receipt/inbox/list/get）无损',async()=>{
 const {store,call}=setup({knowledge:knowledgeStub,appleCalendar:appleStub});
 try{
  const seed=await probe('draft(7 项 create)',()=>call('draft',{title:'铺底',changes:Array.from({length:7},(_,index)=>({op:'create',id:'p'+index,kind:'project',data:{title:'项目 '+index}}))}));
  const revised=await probe('draft(修订同一待确认的改动)',()=>call('draft',{id:seed.id,revision:seed.revision,title:'铺底（修订）',changes:seed.changes}));
  assert.equal(revised.revision,2);
  const committed=await probe('commit(7 项 create)',()=>call('commit',{id:seed.id,revision:revised.revision,key:'seed-commit'}));
  await probe('receipt(幂等键)',()=>call('receipt',{key:'seed-commit'}));
  await probe('preview(已提交 create)',()=>call('preview',{id:seed.id}));
  await probe('inbox(全部)',()=>call('inbox',{}));
  await probe('inbox(draft 过滤)',()=>call('inbox',{status:'draft'}));
  await probe('list(全部)',()=>call('list',{limit:50}));
  await probe('list(按类型 + 搜索 + 含归档)',()=>call('list',{kind:'project',query:'项目',includeArchived:true,limit:5}));
  await probe('get(存在)',()=>call('get',{id:'p0'}));
  await probe('get(缺失，item 必须是 null 而不是 undefined)',async()=>{const value=await call('get',{id:'nope'});assert.equal(value.item,null,'缺失对象必须显式 null');return value});
  const archived=await probe('draft(归档)',()=>call('draft',{title:'归档',changes:[{op:'archive',id:'p1',expectedRevision:1}]}));
  await probe('preview(归档)',()=>call('preview',{id:archived.id}));
  const archivedReceipt=await probe('commit(归档)',()=>call('commit',{id:archived.id,revision:archived.revision,key:'archive-commit'}));
  await probe('preview(已提交 archive，记录编号当时的副本分支)',()=>call('preview',{id:archived.id}));
  await probe('undo_draft(撤销归档)',()=>call('undo_draft',{key:archivedReceipt.key}));
  const cancel=await probe('draft(待取消)',()=>call('draft',{title:'待取消',changes:[{op:'update',id:'p2',expectedRevision:1,data:{title:'项目 2 改名'}}]}));
  await probe('cancel_draft',()=>call('cancel_draft',{id:cancel.id,revision:cancel.revision}));
  await probe('preview(已取消待确认的改动)',()=>call('preview',{id:cancel.id}));
  assertLossless(store.references({workspace:'w',actor:'s'},'p0'),'store.references（preview 的 references 数据源）');
 }finally{store.close()}
});

test('适配器边界：preview 全形态（create/update/archive/restore/delete/混合/带 sources，待确认的改动与已提交）无损',async()=>{
 const {store,call}=setup();
 try{
  const seed=await probe('draft(铺底)',()=>call('draft',{title:'铺底',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'P1'}},
   {op:'create',id:'p2',kind:'project',data:{title:'P2'}},
   {op:'create',id:'p3',kind:'project',data:{title:'P3'}},
   {op:'create',id:'p4',kind:'project',data:{title:'P4'}},
   {op:'create',id:'t1',kind:'task',data:{title:'T1'}},
  ]}));
  await probe('commit(铺底)',()=>call('commit',{id:seed.id,revision:seed.revision,key:'seed'}));
  const preArchived=await probe('draft(先归档 p4)',()=>call('draft',{title:'先归档 p4',changes:[{op:'archive',id:'p4',expectedRevision:1}]}));
  await call('commit',{id:preArchived.id,revision:preArchived.revision,key:'pre-archive'});
  const shapes={
   'create-only(event)':[{op:'create',id:'e1',kind:'event',data:{title:'与示例客户董事长会面',startDate:'2026-10-13T10:00:00+08:00',endDate:'2026-10-13T11:00:00+08:00'}}],
   update:[{op:'update',id:'p1',expectedRevision:1,data:{title:'P1x'}}],
   archive:[{op:'archive',id:'p2',expectedRevision:1}],
   restore:[{op:'restore',id:'p4',expectedRevision:2}],
   delete:[{op:'delete',id:'p3',expectedRevision:1}],
   mixed:[
    {op:'create',id:'p5',kind:'project',data:{title:'P5'}},
    {op:'update',id:'p1',expectedRevision:1,data:{title:'P1y'}},
    {op:'archive',id:'p2',expectedRevision:1},
    {op:'restore',id:'p4',expectedRevision:2},
    {op:'delete',id:'p3',expectedRevision:1},
   ],
   'with sources':[{op:'update',id:'t1',expectedRevision:1,data:{title:'T1x'},sources:{title:'会议纪要第 3 段'}}],
  };
  const drafted={};
  for(const [name,changes] of Object.entries(shapes)){
   drafted[name]=await probe('draft('+name+')',()=>call('draft',{title:name,changes}));
   await probe('preview(待确认的改动 · '+name+')',()=>call('preview',{id:drafted[name].id}));
  }
  // 归档项才带 archivedData；其它 op 不得挂一个值为 undefined 的键。
  // 已提交预览走回执快照分支（另一处独立构造返回值），四种 op 各提交一次核对。
  const committedCreate=await probe('commit(create-only event)',()=>call('commit',{id:drafted['create-only(event)'].id,revision:drafted['create-only(event)'].revision,key:'commit-create'}));
  assert.equal(committedCreate.status,'committed');
  const committedCreatePreview=await probe('preview(已提交 create)',()=>call('preview',{id:drafted['create-only(event)'].id}));
  assert.equal(Object.hasOwn(committedCreatePreview.diff[0],'archivedData'),false,'新建项不该带 archivedData');
  const archiveForCommit=await probe('draft(归档 p2（提交用）)',()=>call('draft',{title:'归档 p2（提交用）',changes:[{op:'archive',id:'p2',expectedRevision:1}]}));
  await probe('commit(归档 p2)',()=>call('commit',{id:archiveForCommit.id,revision:archiveForCommit.revision,key:'commit-archive'}));
  const committedArchive=await probe('preview(已提交 archive 记录编号)',()=>call('preview',{id:archiveForCommit.id}));
  assert.deepEqual(committedArchive.diff[0].archivedData,{title:'P2'});
  assert.equal(committedArchive.diff[0].after,null);
  const updateForCommit=await probe('draft(更新 t1（提交用）)',()=>call('draft',{title:'更新 t1（提交用）',changes:[{op:'update',id:'t1',expectedRevision:1,data:{title:'T1z'}}]}));
  await probe('commit(更新 t1)',()=>call('commit',{id:updateForCommit.id,revision:updateForCommit.revision,key:'commit-update'}));
  const committedUpdate=await probe('preview(已提交 update 记录编号)',()=>call('preview',{id:updateForCommit.id}));
  for(const entry of committedUpdate.diff)assert.equal(Object.hasOwn(entry,'archivedData'),entry.op==='archive','只有归档项才带 archivedData');
  const deleteForCommit=await probe('draft(删除 p3（提交用）)',()=>call('draft',{title:'删除 p3（提交用）',changes:[{op:'delete',id:'p3',expectedRevision:1}]}));
  await probe('commit(删除 p3)',()=>call('commit',{id:deleteForCommit.id,revision:deleteForCommit.revision,key:'commit-delete'}));
  await probe('preview(已提交 delete 记录编号)',()=>call('preview',{id:deleteForCommit.id}));
  const restoreOnly=await probe('preview(restore：after 必须是真实内容)',()=>call('preview',{id:drafted.restore.id}));
  assert.deepEqual(restoreOnly.diff[0].after,{title:'P4'});
 }finally{store.close()}
});

test('适配器边界：读取与派生动作（overview/graph/node_search/layout/execution_history/runtime_status/apple_status/knowledge_*）无损',async()=>{
 const {store,call}=setup({knowledge:knowledgeStub,appleCalendar:appleStub});
 try{
  const seed=await probe('draft(铺底)',()=>call('draft',{title:'铺底',changes:[
   {op:'create',id:'p1',kind:'project',data:{title:'产品 A'}},
   {op:'create',id:'t1',kind:'task',data:{title:'任务 1',projectId:'p1',status:'todo'}},
   {op:'create',id:'a1',kind:'artifact',data:{title:'产品手册',path:'docs/manual.md',fileGrantId:'g1',knowledgeBaseId:'b1',knowledgeDocId:'doc-1'}},
   {op:'create',id:'e1',kind:'event',data:{title:'周会',startDate:'2026-10-13',endDate:'2026-10-13'}},
  ]}));
  await call('commit',{id:seed.id,revision:seed.revision,key:'seed'});
  await probe('overview',()=>call('overview',{}));
  await probe('graph(无 focus)',()=>call('graph',{}));
  await probe('graph(带 focus)',()=>call('graph',{focus:'p1'}));
  await probe('node_search',()=>call('node_search',{query:'产品'}));
  await probe('layout_get(未保存过)',async()=>{const value=await call('layout_get',{view:'main'});assert.equal(value.item,null);return value});
  await probe('layout_save',()=>call('layout_save',{view:'main',revision:0,positions:{},viewport:{x:0,y:0,zoom:1},key:'layout-key'}));
  await probe('layout_get(已保存)',()=>call('layout_get',{view:'main'}));
  await probe('execution_history(空)',()=>call('execution_history',{}));
  await probe('execution_history(按任务过滤)',()=>call('execution_history',{taskId:'t1',limit:10,offset:0}));
  await probe('runtime_status',()=>call('runtime_status',{}));
  await probe('apple_status(有桥接)',()=>call('apple_status',{}));
  await probe('knowledge_bases',()=>call('knowledge_bases',{}));
  await probe('knowledge_status',()=>call('knowledge_status',{id:'a1'}));
  await probe('knowledge_search',()=>call('knowledge_search',{baseId:'b1',query:'产品',topK:5}));
  await probe('knowledge_ingest(存进知识库 → 分阶段结果)',()=>call('knowledge_ingest',{id:'a1',baseId:'b1'}));
 }finally{store.close()}
});

test('适配器边界：apple_status 无桥接、execution_start 真实 ledger+runner',async()=>{
 const {store,call}=setup({appleCalendar:null});
 const store2=new WorkstationStore(':memory:');
 const ledger=new ExecutionStore(store2);
 const realRunner=new ExecutionRunner(ledger,{status:()=>({provider:true,toolFilter:true}),start:async()=>({id:'child-session',result:Promise.resolve({stopReason:'completed',output:[]}),dispose:async()=>{}})});
 const adapter=new DshAdapter({
  store:store2,executions:ledger,runner:realRunner,executionConfig:{enabled:true},
  sessions:{get:()=>({header:{cwd:CWD}})},workspaceRegistry:{resolveByPath:async()=>({id:'w'})},
  allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'},
 });
 const call2=(action,args={})=>adapter.run({action,...args},exec);
 try{
  await probe('apple_status(无桥接)',()=>call('apple_status',{}));
  const seed=await probe('draft(任务)',()=>call2('draft',{title:'任务',changes:[{op:'create',id:'t1',kind:'task',data:{title:'可执行任务'}}]}));
  await call2('commit',{id:seed.id,revision:seed.revision,key:'seed'});
  await probe('execution_start(真实 reserve/started/finish)',()=>call2('execution_start',{taskId:'t1',revision:1,key:'run-1'}));
  await probe('execution_history(有记录)',()=>call2('execution_history',{}));
  assert.equal(realRunner.pending.size,0,'执行结束后不应残留挂起操作');
 }finally{store.close();store2.close();await realRunner.close()}
});

test('适配器边界：语音转写（含"宿主不保证 language"的防御分支）无损',async()=>{
 const current=setup({speech:speechFillsLanguage});
 try{
  const value=await probe('transcribe(本机宿主：resolve 会补 language)',()=>current.call('transcribe',{grantId:'g1',path:'meetings/2026-10-12.wav',language:'zh'}));
  assert.equal(value.language,'zh');
 }finally{current.store.close()}
 const defensive=setup({speech:speechOmitsLanguage});
 try{
  // 契约依据：本机宿主 resolve() = request.language ?? config.language.get()，且
  // config.language 是 z.string().min(1).default('auto') → 正常情况不会走到这里。
  // 这条覆盖的是"宿主契约变化/更旧构建不填 language"的边界：返回值仍必须能无损过 JSON，
  // 不能被一个 undefined 把整次工具调用打掉。修复前此处会红（language = undefined）。
  const value=await probe('transcribe(防御分支：resolve 不填 language)',()=>defensive.call('transcribe',{grantId:'g1',path:'meetings/2026-10-12.wav'}));
  assert.equal(value.language,null,'没有语言信息时必须是显式 null，不能是 undefined');
 }finally{defensive.store.close()}
});
