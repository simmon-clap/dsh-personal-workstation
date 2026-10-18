import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createWorkspaceApi} from '../prototype/api.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ROOT_SCOPE} from '../src/scope.mjs';
import {httpRoute} from '../src/http-route.mjs';

// PRD v1.0 §14 / v1.1 IN-AC-3：断连、半途失败与重试路径必须有确定行为，且重试不得重复写入。
function boot(){
 const store=new WorkstationStore(':memory:');
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,connection,workspaceRegistry:{list:()=>[{id:'w',title:'W'}],get:id=>id==='w'?{id:'w'}:null},allowedWorkspaces:['w']});
 return {store,connection,route};
}
async function serve(route){
 const server=createServer((q,s)=>route.handler(q,s));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:'http://127.0.0.1:'+server.address().port,url:'http://127.0.0.1:'+server.address().port+'/personal-workstation/api',close:()=>new Promise(resolve=>server.close(resolve))};
}
test('a dropped connection is reported as an actionable failure, never as success',async()=>{
 const send=createWorkspaceApi('w',{fetch:async()=>{throw new TypeError('Failed to fetch')}});
 const error=await send('list',{}).then(()=>null,reason=>reason);
 assert(error);assert.match(error.message,/无法连接工作台服务/);
 assert.match(error.message,/重试是安全的/,'必须告知重试是安全的，否则用户会重复录入');
 assert.doesNotMatch(error.message,/Failed to fetch/,'不得把底层英文错误直接抛给用户');
});
test('an unparseable response is reported as uncertain instead of as failure or success',async()=>{
 const send=createWorkspaceApi('w',{fetch:async()=>new Response('<html>502 Bad Gateway</html>',{status:502,headers:{'content-type':'text/html'}})});
 const error=await send('commit',{id:'b',revision:1,key:'k'}).then(()=>null,reason=>reason);
 assert(error);assert.match(error.message,/无法解析/);assert.match(error.message,/502/);
 assert.match(error.message,/尚不确定本次操作是否生效/,'网关错误页不能断言操作失败——可能已经写入');
});
test('a server-side business error keeps its own message and code',async()=>{
 const send=createWorkspaceApi('w',{fetch:async()=>new Response(JSON.stringify({message:'版本冲突，请重新预览'}),{status:409,headers:{'content-type':'application/json'}})});
 const error=await send('commit',{id:'b',revision:1,key:'k'}).then(()=>null,reason=>reason);
 assert.equal(error.message,'版本冲突，请重新预览');
});
test('a switched workspace aborts in-flight requests instead of applying them',async()=>{
 let current=true;
 const send=createWorkspaceApi('w',{fetch:async()=>{current=false;return new Response(JSON.stringify({items:[]}),{status:200,headers:{'content-type':'application/json'}})},isCurrent:()=>current});
 const error=await send('list',{}).then(()=>null,reason=>reason);
 assert.equal(error.message,'数据刚更新过，请重试');
});
test('retrying a commit after a lost response returns the same receipt and writes exactly one object',async()=>{
 const {store,connection,route}=boot();
 const server=await serve(route);
 // 浏览器里请求相对路径；测试中把它解析到本地服务器的绝对地址。
 const send=createWorkspaceApi('w',{fetch:(path,options)=>fetch(new URL(path,server.url).href,options)});
 try{
  const draft=await send('draft',{title:'断网重试',changes:[{op:'create',id:'p-retry',kind:'project',data:{title:'只应出现一次'}}]});
  const first=await send('commit',{id:draft.id,revision:1,key:'ui:'+draft.id+':1'});
  assert.equal(first.status,'committed');
  // 模拟响应丢失后用户重试：同一幂等键必须返回同一回执，而不是第二次写入。
  const retry=await send('commit',{id:draft.id,revision:1,key:'ui:'+draft.id+':1'});
  assert.equal(retry.status,'committed');
  assert.equal(retry.receipt?.revision,first.receipt?.revision,'重试不得产生新版本');
  const items=await send('list',{});
  assert.deepEqual(items.items.map(item=>item.data.title),['只应出现一次']);
  // 回执落在根作用域（数据跟着根目录走）：直接查库时要用 ROOT_SCOPE
  const history=store.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE workspace=? AND key=?').get(ROOT_SCOPE,'ui:'+draft.id+':1');
  assert.equal(history.n,1,'幂等键只应留下一个记录编号');
  void connection;
 }finally{await server.close();store.close()}
});
test('a transient failure followed by a retry still writes exactly once',async()=>{
 const {store,route}=boot();
 const server=await serve(route);
 const real=globalThis.fetch;let failed=0;
 // 只让提交这一次请求断网，读取与草稿正常，模拟「提交时正好断线」。
 const flaky=(path,options)=>{
  const body=String(options?.body??'');
  if(body.includes('"action":"commit"')&&failed===0){failed+=1;throw new TypeError('network down')}
  return real(new URL(path,server.url).href,options);
 };
 const send=createWorkspaceApi('w',{fetch:flaky});
 try{
  const draft=await send('draft',{title:'瞬时故障',changes:[{op:'create',id:'t-retry',kind:'topic',data:{title:'课题'}}]});
  await assert.rejects(send('commit',{id:draft.id,revision:1,key:'ui:'+draft.id+':1'}),/无法连接工作台服务/);
  assert.equal((await send('list',{})).items.length,0,'第一次失败不得留下半个对象');
  const retry=await send('commit',{id:draft.id,revision:1,key:'ui:'+draft.id+':1'});
  assert.equal(retry.status,'committed');
  assert.deepEqual((await send('list',{})).items.map(item=>item.data.title),['课题']);
 }finally{await server.close();store.close()}
});
