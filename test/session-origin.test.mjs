import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readBatchOrigin,ORIGIN_MESSAGE_LIMIT} from '../src/session-origin.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {WorkstationStore} from '../src/store.mjs';

// PRD v1.1 IN-AC-10：结果要能追溯到具体指令，且只能用服务端记录过的来源会话。
const queryOf=messages=>({
 filterEvents:async()=>messages,
 readTitle:async()=>({title:'飞书 · 会议整理'}),
});
test('the origin reader returns only user instructions, newest last, with a bounded size',async()=>{
 const messages=Array.from({length:9},(_,index)=>({seq:index+1,time:1700000000000+index,type:'user/message',text:'指令 '+(index+1)+' '+ 'x'.repeat(900)}));
 const origin=await readBatchOrigin(queryOf(messages),'session-1');
 assert.equal(origin.available,true);
 assert.equal(origin.count,9);
 assert(origin.messages.length<=ORIGIN_MESSAGE_LIMIT,'条数必须封顶');
 assert(origin.messages.length>=1,'至少要给出最近一条指令');
 assert.equal(origin.messages.at(-1).text.startsWith('指令 9'),true,'最新的指令必须在最后且可见');
 assert(origin.truncated,'被截断必须如实标记');
 const total=origin.messages.reduce((sum,message)=>sum+message.text.length,0);
 assert(total<=2400,'总字符数必须封顶，避免把整段会话塞进界面');
 assert.equal(origin.title,'飞书 · 会议整理');
});
test('manual batches and missing services report why instead of inventing an origin',async()=>{
 const manual=await readBatchOrigin(queryOf([]),undefined);
 assert.equal(manual.available,false);assert.match(manual.reason,/人工录入/);
 const noService=await readBatchOrigin(undefined,'session-1');
 assert.equal(noService.available,false);assert.match(noService.reason,/未加载会话查询服务/);
 const failing=await readBatchOrigin({filterEvents:async()=>{throw new Error('日志不可读')}},'session-1');
 assert.equal(failing.available,false);assert.match(failing.reason,/日志不可读/);
 const empty=await readBatchOrigin(queryOf([]),'session-1');
 assert.equal(empty.available,true);assert.deepEqual(empty.messages,[]);
});
test('the browser route reads the session recorded on the batch and ignores a forged one',async()=>{
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const batch=store.draft(ctx,{title:'来自会话',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}],source:{sessionId:'session-real',callId:'c1'}});
 const asked=[];
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],
  sessionQuery:{filterEvents:async id=>{asked.push(id);return [{seq:1,time:1,type:'user/message',text:'把会议纪要整理成项目'}]},readTitle:async()=>({title:'真实会话'})}});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const origin=await call({action:'batch_origin',id:batch.id,sessionId:'session-forged'});
  assert.equal(origin.available,true);
  assert.deepEqual(asked,['session-real'],'只能读服务端记录的来源会话，不接受调用方传入的会话');
  assert.deepEqual(origin.messages.map(message=>message.text),['把会议纪要整理成项目']);
  assert.equal((await call({action:'batch_origin',id:'missing'})).error,'NOT_FOUND');
 }finally{store.close()}
});
