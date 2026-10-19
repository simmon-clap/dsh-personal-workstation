import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';

// G2 入口链路契约：任何入口（工作台页面 / DSH 普通对话 / IM 助理）都走同一个工具与同一批数据。
const WORKSPACE={id:'w-allowed',title:'飞书工作区',path:'/workspace/飞书工作区'};
const OTHER={id:'w-other',title:'slack 工作区',path:'/workspace/slack 工作区'};
function setup({approval='allowed-once',allowed=[WORKSPACE.id],cwd=WORKSPACE.path}={}){
 const store=new WorkstationStore(':memory:');
 const workspaces=[WORKSPACE,OTHER];
 const adapter=new DshAdapter({
  store,
  sessions:{get:id=>id==='session-im'?{header:{cwd}}:null},
  workspaceRegistry:{resolveByPath:async path=>workspaces.find(w=>w.path===path)??null,get:id=>workspaces.find(w=>w.id===id)??null},
  allowedWorkspaces:allowed,
  approval:{request:async()=>typeof approval==='function'?approval():approval},
 });
 return {store,adapter,call:(action,args={})=>adapter.run({action,...args},{agent:{id:'session-im'},callId:'call-1'})};
}
test('an IM-originated session writes into the same inbox and objects the workbench page reads',async()=>{
 const {store,call}=setup();
 try{
  const draft=await call('draft',{title:'IM 录入',changes:[{op:'create',id:'p-im',kind:'project',data:{title:'来自 IM 的项目'}}]});
  const inbox=await call('inbox',{status:'draft'});
  assert.equal(inbox.items.length,1,'IM 生成的待确认的改动必须出现在工作台收件箱');
  assert.equal(inbox.items[0].id,draft.id);
  await call('commit',{id:draft.id,revision:1,key:'im-1'});
  const listed=await call('list',{});
  assert.deepEqual(listed.items.map(item=>item.data.title),['来自 IM 的项目'],'提交后必须出现在工作台页面读取的同一份数据里');
  const status=await call('runtime_status');
  assert.equal(status.workspace.id,WORKSPACE.id,'运行状态必须报告当前会话绑定到哪个工作区');
  assert.equal(status.workspace.title,WORKSPACE.title);
  assert.equal(status.writeRequiresApproval,true,'写入需要审批必须如实报告');
 }finally{store.close()}
});
test('an IM session that is refused approval can still leave a draft but cannot commit it',async()=>{
 const {store,call}=setup({approval:'rejected'});
 try{
  const draft=await call('draft',{title:'IM 录入',changes:[{op:'create',id:'p-im',kind:'project',data:{title:'不该写入'}}]});
  assert.equal((await call('inbox',{})).items.length,1,'待确认的改动是待处理的建议，应当留在收件箱');
  assert.equal((await call('list',{})).items.length,0,'待确认的改动不得改变业务数据');
  await assert.rejects(call('commit',{id:draft.id,revision:1,key:'im-x'}),/未获许可|FORBIDDEN/,'没有审批不得提交');
  assert.equal((await call('list',{})).items.length,0,'审批被拒后不得留下对象');
 }finally{store.close()}
});
test('an IM session can draft and commit once approval is granted',async()=>{
 let outcome='rejected';
 const {store,call}=setup({approval:()=>outcome});
 try{
  const draft=await call('draft',{title:'IM 录入',changes:[{op:'create',id:'p-im',kind:'project',data:{title:'来自 IM'}}]});
  await assert.rejects(call('commit',{id:draft.id,revision:1,key:'im-1'}),/未获许可/);
  outcome='allowed-once';
  const receipt=await call('commit',{id:draft.id,revision:1,key:'im-1'});
  assert.equal(receipt.status,'committed');
  assert.deepEqual((await call('list',{})).items.map(item=>item.data.title),['来自 IM']);
 }finally{store.close()}
});
test('a session in an unauthorized workspace fails with an actionable message',async()=>{
 const {store,call}=setup({cwd:OTHER.path});
 try{
  const error=await call('list',{}).then(()=>null,reason=>reason);
  assert(error,'未授权工作区必须失败');
  // 2026-10-14：报错不再给工作区 id 与配置项名 —— 用户能做的动作是"在工作台里给文件夹授权"，
  // 把 cordis.patch.yml / allowedWorkspaces 端给他是"不说人话"（用户当天点名）。名字要留着便于确认。
  assert.match(error.message,new RegExp(OTHER.title),'错误应带上可读的名称便于人工确认');
  assert.match(error.message,/设置 → 能读写哪些文件夹/,'错误必须给出界面里那一步');
  assert.doesNotMatch(error.message,new RegExp(OTHER.id + '|allowedWorkspaces|cordis'),'不许把内部 id 与配置项端给用户');
  assert.equal((await store.inbox({workspace:WORKSPACE.id,actor:'t'})).length,0);
 }finally{store.close()}
});
test('a session whose directory is not a registered workspace fails closed with the path',async()=>{
 const {store,call}=setup({cwd:'/home/user/.dsh/profiles/desktop'});
 try{
  const error=await call('list',{}).then(()=>null,reason=>reason);
  assert(error,'未注册目录必须失败');
  assert.match(error.message,/profiles\/desktop/,'错误必须回显实际目录');
  assert.match(error.message,/添加为工作区/,'错误必须给出下一步');
 }finally{store.close()}
});
test('the tool refuses workspace or permission claims from the model',async()=>{
 const {store,adapter}=setup();
 try{
  await assert.rejects(adapter.run({action:'list',workspace:'w-other'},{agent:{id:'session-im'}}),/不接受工作区、权限或未知参数/);
  await assert.rejects(adapter.run({action:'draft',canWrite:true,title:'x',changes:[]},{agent:{id:'session-im'}}),/不接受工作区、权限或未知参数/);
 }finally{store.close()}
});

test('runtime_status reports whether Office preview and speech services are actually loaded',async()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const build=extra=>new DshAdapter({store,...extra,sessions:{get:id=>id==='session-im'?{header:{cwd:'/w'}}:null},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w',title:'W'})},allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'}});
  const pluginOnly=await build({}).run({action:'runtime_status'},{agent:{id:'session-im'}});
  assert.equal(pluginOnly.capabilities.officePreview,false,'没有转换服务时必须报告未接入');
  assert.equal(pluginOnly.capabilities.speechToText,false);
  const wired=await build({office:{},speech:{}}).run({action:'runtime_status'},{agent:{id:'session-im'}});
  assert.equal(wired.capabilities.officePreview,true);
  assert.equal(wired.capabilities.speechToText,true);
 }finally{store.close()}
});

test('the browser settings path reports the same capabilities as the Agent tool',async()=>{
 const {browserRoute}=await import('../src/browser-api.mjs');
 const store=new WorkstationStore(':memory:');
 try{
  const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w',title:'飞书工作区'}),list:()=>[{id:'w',title:'飞书工作区'}]},allowedWorkspaces:['w'],files:{grants:[]},office:{},speech:undefined});
  const call=async action=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({action,workspace:'w'})}));return response.json()};
  const status=await call('runtime_status');
  assert.equal(status.capabilities.officePreview,true,'浏览器设置面板必须看到已加载的 Office 转换服务');
  assert.equal(status.capabilities.speechToText,false);
  assert.equal(status.workspace.title,'飞书工作区','设置面板要显示工作区名称而不是只显示 id');
  assert.equal(status.writeRequiresApproval,true);
 }finally{store.close()}
});

test('runtime_status reports speech provider preparation instead of only presence',async()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const build=speech=>new DshAdapter({store,sessions:{get:id=>id==='s'?{header:{cwd:'/w'}}:null},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w'})},allowedWorkspaces:['w'],approval:{request:async()=>'allowed-once'},speech});
  const shaped=await build({snapshot:()=>({providers:[{id:'sensevoice',name:'SenseVoiceSmall (INT8)',preparation:{phase:'standby'}}],selection:{providerId:'sensevoice',language:'auto'}})}).run({action:'runtime_status'},{agent:{id:'s'}});
  assert.equal(shaped.capabilities.speechToText,true);
  assert.deepEqual(shaped.capabilities.speech.providers,[{id:'sensevoice',name:'SenseVoiceSmall (INT8)',phase:'standby'}],'必须报告模型准备状态');
  assert.equal(shaped.capabilities.speech.selection.providerId,'sensevoice');
  const broken=await build({snapshot(){throw new Error('boom')}}).run({action:'runtime_status'},{agent:{id:'s'}});
  assert.equal(broken.capabilities.speechToText,true,'当时的副本失败也不能说成未接入');
  assert.equal(broken.capabilities.speech.providers.length,0);
 }finally{store.close()}
});
