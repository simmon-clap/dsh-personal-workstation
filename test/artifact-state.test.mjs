import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {artifactState,artifactStates} from '../src/artifact-state.mjs';
import {artifactStateLine} from '../prototype/record-detail.mjs';

// PRD v1.3 CH-05：跨服务修改显示分阶段结果，不承诺原子事务。
// 工作台里真实的跨服务写入是「文件系统 + 数据库」：文件会变，记录不会自动跟着变。
const ctx={workspace:'w',actor:'t',canWrite:false};
// probe 可以是返回值，也可以是抛错的函数（模拟授权被拒/磁盘不可读）。
const filesWith=probe=>({version:async()=>typeof probe==='function'?probe():probe});
test('the record/file comparison reports each staged outcome without rewriting the record',async()=>{
 const artifact={data:{title:'材料',path:'docs/a.pdf',fileGrantId:'g1',fileVersion:'v1'}};
 assert.equal((await artifactState(filesWith({exists:true,type:'file',size:10,version:'v1'}),ctx,artifact)).status,'current');
 const changed=await artifactState(filesWith({exists:true,type:'file',size:12,version:'v2'}),ctx,artifact);
 assert.equal(changed.status,'changed');
 assert.equal(changed.recordVersion,'v1');assert.equal(changed.currentVersion,'v2');
 assert.equal((await artifactState(filesWith({exists:false,type:null,size:null,version:null}),ctx,artifact)).status,'missing');
 assert.equal((await artifactState(filesWith(()=>{throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'})}),ctx,artifact)).status,'ungranted');
 assert.equal((await artifactState(undefined,ctx,artifact)).status,'unknown');
 assert.equal((await artifactState(filesWith({exists:true,type:'file',size:1,version:'v1'}),ctx,{data:{title:'无版本',path:'a.pdf',fileGrantId:'g1'}})).status,'unknown','没有记录版本就不能声称一致');
 assert.equal((await artifactState(filesWith({exists:true,type:'file',size:1,version:'v1'}),ctx,{data:{title:'无路径'}})).status,'unknown');
});
test('the comparison never returns a success state for an unreadable file',async()=>{
 const artifact={data:{path:'a.pdf',fileGrantId:'g1',fileVersion:'v1'}};
 const failure=await artifactState(filesWith(()=>{throw new Error('磁盘不可读')}),ctx,artifact);
 assert.equal(failure.status,'unknown');
 assert.match(failure.reason,/磁盘不可读/);
 assert(Object.values(artifactStates).includes(failure.status===('changed')?'文件已变化，记录仍指向旧版本':artifactStates[failure.status]));
});
test('the browser route reads the stored record and refuses archived ones',async()=>{
 const store=new WorkstationStore(':memory:'),write={workspace:'w',actor:'t',canWrite:true};
 const batch=store.draft(write,{title:'材料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'材料',path:'docs/a.pdf',fileGrantId:'g1',fileVersion:'v1'}}]});
 store.commit(write,{batchId:batch.id,revision:1,key:'k'});
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],files:filesWith({exists:true,type:'file',size:10,version:'v2'})});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const state=await call({action:'artifact_state',id:'a1'});
  assert.equal(state.status,'changed','界面必须能看出文件已经变了');
  assert.equal(store.get({workspace:'w',actor:'t'},'a1').data.fileVersion,'v1','比较不得改写记录');
  const archived=store.draft(write,{title:'归档',changes:[{op:'archive',id:'a1',expectedRevision:1}]});
  store.commit(write,{batchId:archived.id,revision:1,key:'k2'});
  assert.equal((await call({action:'artifact_state',id:'a1'})).error,'NOT_FOUND');
 }finally{store.close()}
});
test('the detail line states the staged result and never calls a stale file consistent',()=>{
 assert.match(artifactStateLine({status:'current',version:'v1'}),/记录与文件一致/);
 const changed=artifactStateLine({status:'changed',recordVersion:'v1',currentVersion:'v2'});
 assert.match(changed,/文件已变化，记录仍指向旧版本/);
 assert.match(changed,/记录版本 v1/);assert.match(changed,/当前版本 v2/);
 assert.doesNotMatch(changed,/一致/,'旧版本不能显示成一致');
 assert.match(artifactStateLine({status:'missing'}),/文件不存在/);
 assert.match(artifactStateLine({status:'ungranted',reason:'文件授权不足'}),/没有可用的文件授权/);
 assert.match(artifactStateLine({status:'unknown',reason:'宿主未加载文件服务'}),/宿主未加载文件服务/);
});
test('an artifact record shows its staged file state in the dialog',async()=>{
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const item={id:'a1',kind:'artifact',revision:1,archived:false,data:{title:'材料',path:'docs/a.pdf',fileGrantId:'g1',fileVersion:'v1'}};
 const send=async action=>{
  if(action==='get')return {item};
  if(action==='artifact_state')return {status:'changed',recordVersion:'v1',currentVersion:'v2'};
  throw Error(action);
 };
 const detail=createRecordDetail(document,send,{notify:()=>{}});
 try{
  await detail.open('a1');
  for(let index=0;index<4;index+=1)await new Promise(resolve=>setImmediate(resolve));
  const block=document.querySelector('#detailbody [data-artifact-state]');
  assert(block,'资料详情必须显示文件状态');
  assert.match(block.textContent,/文件已变化，记录仍指向旧版本/);
  assert.match(block.textContent,/当前版本 v2/);
 }finally{detail.dispose();dom.window.close()}
});
