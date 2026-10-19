import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ROOT_SCOPE} from '../src/scope.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createBatchFlow} from '../prototype/batch.mjs';
import {createEditor} from '../prototype/editor.mjs';

// PRD v1.0 §14：提交失败后界面必须能重试，且重试不得重复写入（同一幂等键）。
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function bridge(store,{failCommits=0}={}){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 const keys=[];let remaining=failCommits;
 return {keys,async send(action,data={}){
  if(action==='commit'){keys.push(data.key);if(remaining>0){remaining-=1;throw Error('无法连接工作台服务（网络中断或服务未启动）。请检查连接后重试；提交使用同一幂等键，重试不会重复写入。')}}
  const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));
  const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value;
 }};
}
test('a commit that fails on a dropped connection can be retried from the save bar with one write',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document;
 const notices=[],bridgePort=bridge(store,{failCommits:1});
 const batch=createBatchFlow(document,bridgePort.send,{notify:(text,error)=>notices.push({text,error}),confirm:()=>true});
 const editor=createEditor(document,bridgePort.send,batch,{notify:(text,error)=>notices.push({text,error})});
 try{
  await editor.open('topic');await tick();
  document.querySelector('[data-field="title"]').value='断网提交的议题';
  // 你自己填的表单：保存即生效（不再弹确认框），失败时保留草稿并给「重试」。
  document.querySelector('#objpreview').click();await tick();await tick();await tick();
  assert(notices.some(item=>item.error&&/无法连接工作台服务/.test(item.text)),'断连必须给出可操作提示');
  assert.equal(store.inbox({workspace:'w',actor:'t',canWrite:true}).length,1,'第一次失败时草稿必须还在，否则用户要重新录入');
  assert.equal((await bridgePort.send('list',{})).items.length,0,'断连时不得写入任何对象');
  const bar=document.querySelector('#undobar');
  assert(bar&&!bar.hidden,'必须出现可重试的保存条，而不是静默失败或空对话框');
  const retry=bar.querySelector('[data-undobutton]');
  assert(retry&&/重试/.test(retry.textContent),'保存条上要有「重试」');
  retry.click();await tick();await tick();await tick();
  assert.equal(bridgePort.keys.length,2,'应当发生两次提交尝试');
  assert.equal(bridgePort.keys[0],bridgePort.keys[1],'重试必须复用同一幂等键，否则会重复写入');
  assert.deepEqual((await bridgePort.send('list',{})).items.map(item=>item.data.title),['断网提交的议题'],'重试后只应有一个对象');
  assert(store.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE workspace=? AND key=?').get(ROOT_SCOPE,bridgePort.keys[1]).n===1,'幂等键只应留下一个记录编号（记录编号在根作用域）');
  assert(/已保存/.test(bar.textContent),'重试成功后保存条要说已保存，并可以撤销');
 }finally{store.close();dom.window.close()}
});
