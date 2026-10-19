import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';
import {filePreviewRoute} from '../src/file-preview-route.mjs';

const scratch=()=>mkdtempSync(join(tmpdir(),'workspace-allow-'));

test('a workspace can be authorised at runtime and the authorisation survives a reload',()=>{
 const home=scratch(),data=join(home,'data');
 try{
  const store=createWorkspaceStore({directory:data});
  assert.deepEqual(store.list(),[],'初始没有任何运行时授权');
  assert.deepEqual(store.add('w2'),{id:'w2',added:true});
  assert.deepEqual(store.add('w2'),{id:'w2',added:false},'重复授权不重复记录');
  assert.match(readFileSync(join(data,'workspaces.json'),'utf8'),/w2/,'授权必须落盘');
  const reloaded=createWorkspaceStore({directory:data});
  assert.deepEqual(reloaded.list(),['w2'],'重新加载（相当于重启）后授权仍在：授权是数据，不是内存状态');
  assert.equal(reloaded.has('w2'),true);
  assert.deepEqual(reloaded.remove('w2'),{id:'w2',removed:true});
  assert.deepEqual(reloaded.remove('w2'),{id:'w2',removed:false},'撤销不存在的授权不是错误，也不写盘');
  assert.deepEqual(createWorkspaceStore({directory:data}).list(),[]);
 }finally{rmSync(home,{recursive:true,force:true})}
});

test('runtime authorisation is refused for empty ids and never rewrites the config list',()=>{
 const home=scratch(),data=join(home,'data'),configured=['w1'];
 try{
  const store=createWorkspaceStore({directory:data});
  assert.throws(()=>store.add('   '),/需要工作区 id/);
  assert.throws(()=>store.remove(''),/需要工作区 id/);
  store.add('w2');
  // 插件里就是这条取函数：配置 ∪ 运行时；撤销运行时项不会动配置项。
  const allowed=()=>[...new Set([...configured,...store.list()])];
  assert.deepEqual(allowed(),['w1','w2']);
  store.remove('w1');
  assert.deepEqual(allowed(),['w1','w2'],'配置文件里的授权只能改配置，界面撤销动不了它');
  store.remove('w2');
  assert.deepEqual(allowed(),['w1']);
 }finally{rmSync(home,{recursive:true,force:true})}
});

test('browser API can list every registered workspace and grant one before it is authorised',async()=>{
 const home=scratch(),data=join(home,'data'),registry=[{id:'w',title:'飞书工作区',path:'/ws'},{id:'hidden',title:'其他工作区',path:'/other'}];
 try{
  const store=createWorkspaceStore({directory:data});
  const configured=['w'];
  const allowed=()=>[...new Set([...configured,...store.list()])];
  const route=browserRoute({store:{},connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>registry.find(w=>w.id===id)??null,list:()=>registry},allowedWorkspaces:allowed,configuredWorkspaces:configured,workspaces:store});
  const call=body=>route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify(body)}));
  const catalog=await (await call({action:'workspace_catalog',workspace:'hidden'})).json();
  assert.equal(catalog.items.length,2,'清单来自工作区注册表，不受当前工作区是否授权影响');
  assert.deepEqual(catalog.items.find(w=>w.id==='w'),{id:'w',title:'飞书工作区',path:'/ws',authorized:true,runtime:false,configured:true});
  assert.deepEqual(catalog.items.find(w=>w.id==='hidden'),{id:'hidden',title:'其他工作区',path:'/other',authorized:false,runtime:false,configured:false});
  // 未授权的工作区连 list 都进不去
  assert.equal((await call({action:'list',workspace:'hidden'})).status,403);
  const granted=await (await call({action:'workspace_allow',workspace:'hidden',id:'hidden'})).json();
  assert.deepEqual(granted,{id:'hidden',added:true,items:granted.items,allowed:['w','hidden']});
  assert.equal(granted.items.find(w=>w.id==='hidden').runtime,true,'运行时授权要标出来，界面才知道哪个能撤销');
  // 授权后同一个路由立刻放行，不需要重启
  assert.equal(store.has('hidden'),true);
  assert.equal((await call({action:'workspace_allow',workspace:'w',id:'不存在的 id'})).status,400,'不能手填一个没注册的 id');
  assert.equal((await call({action:'workspace_disallow',workspace:'w',id:'hidden'})).status,200);
  assert.deepEqual(store.list(),[],'撤销后运行时清单为空');
  assert.equal((await call({action:'list',workspace:'hidden'})).status,403,'撤销后立刻恢复拒绝');
 }finally{rmSync(home,{recursive:true,force:true})}
});

test('the agent-side gate reads the allow-list live and its error names the in-app fix',async()=>{
 const home=scratch(),data=join(home,'data'),configured=[];
 try{
  const store=createWorkspaceStore({directory:data});
  const allowed=()=>[...new Set([...configured,...store.list()])];
  const adapter=new DshAdapter({store:{},sessions:{get:id=>id==='agent'?{header:{cwd:'/ws'}}:null},workspaceRegistry:{resolveByPath:async path=>path==='/ws'?{id:'w',title:'飞书工作区'}:null},approval:{},allowedWorkspaces:allowed});
  const exec={agent:{id:'agent'}};
  await assert.rejects(()=>adapter.context(exec),error=>{
   assert.equal(error.code,'FORBIDDEN');
   assert.match(error.message,/设置 → 能读写哪些文件夹/,'错误必须指向界面里那个开关');
   assert.doesNotMatch(error.message,/cordis\.patch\.yml|profile|配置项/,'不许把配置文件路径端给用户（用户 2026-10-14 点名"不说人话"）');
   return true;
  });
  store.add('w');
  assert.deepEqual(await adapter.context(exec),{workspace:'w',actor:'agent',canWrite:false},'界面授权后同一个适配器实例立即可用');
  store.remove('w');
  await assert.rejects(()=>adapter.context(exec),/还没有接上/,'撤销后立即恢复拒绝');
 }finally{rmSync(home,{recursive:true,force:true})}
});

test('the preview route accepts the same live allow-list',async()=>{
 const home=scratch(),data=join(home,'data');
 try{
  const store=createWorkspaceStore({directory:data});
  const route=filePreviewRoute({connection:{admit:()=>({peer:{id:'operator'}})},allowedWorkspaces:()=>['w'],files:{}});
  const call=workspace=>route.fetch(new Request('http://localhost/personal-workstation/file?workspace='+workspace+'&grantId=g&path=a.png'));
  assert.equal((await call('hidden')).status,403);
  assert.notEqual((await call('w')).status,403,'授权的工作区不该在预览入口被拦');
  assert.equal((await filePreviewRoute({connection:{admit:()=>({peer:{id:'operator'}})},allowedWorkspaces:['w'],files:{}}).fetch(new Request('http://localhost/personal-workstation/file?workspace=hidden&grantId=g&path=a.png'))).status,403,'数组形式仍然支持');
 }finally{rmSync(home,{recursive:true,force:true})}
});
