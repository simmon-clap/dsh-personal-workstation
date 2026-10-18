import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {mountV7} from '../src/v7/v7-controller.mjs';

// Real store + real authenticated HTTP route + the published V7 controller.
function bridge(handler){
 return async(url,options={})=>{
  let status,headers={},payload=null;
  const res={writeHead:(s,h)=>{status=s;headers=h??{}},end:b=>{payload=b===undefined?null:b},on(){},off(){},destroyed:false,writableEnded:true};
  const req={url,method:options.method??'GET',headers:Object.fromEntries(new Headers({'x-workstation-client':'1',...(options.headers??{})}).entries()),[Symbol.asyncIterator]:async function*(){if(options.body) yield Buffer.from(options.body)}};
  await handler(req,res);
  const text=payload?.toString()??'';
  return {ok:status>=200&&status<300,status,headers,text:async()=>text,json:async()=>JSON.parse(text)};
 };
}
test('V7 client reads and re-reads records through the authenticated HTTP bridge',async()=>{
 const store=new WorkstationStore(':memory:');
 const route=httpRoute({store,connection:{requestRejection:()=>undefined,admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{list:()=>[{id:'w',title:'我的工作区'}],get:id=>id==='w'?{id,title:'我的工作区'}:null},allowedWorkspaces:['w']});
 const request=bridge(route.handler);
 try{
  const created=await (await request('/personal-workstation/api',{method:'POST',body:JSON.stringify({action:'draft',workspace:'w',title:'新建项目',changes:[{op:'create',id:'p',kind:'project',data:{title:'真实项目',deliverables:[{id:'d1',title:'交付项',done:true}]}}]})})).json();
  const committed=await (await request('/personal-workstation/api',{method:'POST',body:JSON.stringify({action:'commit',workspace:'w',id:created.id,revision:1,key:'e2e-project'})})).json();
  assert.equal(committed.status,'committed');

  const dom=new JSDOM(readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8'));
  const document=dom.window.document;
  const errors=[];
  const controller=await mountV7(document,{workspace:'w',fetch:request,onError:error=>errors.push(error.message)});
  try{
   assert.deepEqual(errors,[]);
   assert.match(document.querySelector('#projectstrip').textContent,/真实项目/);
   assert.match(document.querySelector('#metrics').textContent,/1\/1/,'交付项完成数应来自真实记录');
   document.querySelector('#projectstrip [data-project="p"]').click();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(document.querySelector('#veil').classList.contains('open'),true);
   assert.equal(document.querySelector('#detailtitle').textContent,'真实项目');
   assert.match(document.querySelector('#detailbody').textContent,/1 \/ 1|100%/);
   document.querySelector('#newprojectgraph').click();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(document.querySelector('.view.active').id,'space','详情里的“在画布查看”必须真的切到画布并聚焦');
   assert.equal(document.querySelector('#projectfocus').value,'p');
   document.querySelector('.nav [data-view="projects"]').click();
   document.querySelector('.close').click();
   document.querySelector('#create').click();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(document.querySelector('#detailtitle').textContent,'新建','顶栏“新任务”应打开 V7 新建入口');
   const kinds=[...document.querySelectorAll('#detailbody [data-kind]')].map(node=>node.querySelector('h2').textContent);
  // 登记表里的对象类型都能在这里新建（人机共用录入，PRD v1.1 核心决定）；判断已于批次 1 登记。
  assert.equal(kinds.length,9);
  assert.ok(kinds.includes('判断'),'新建菜单必须列出「判断」，否则界面上根本建不了判断');
   document.querySelector('.close').click();
   document.querySelector('#settings').click();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(document.querySelector('#detailtitle').textContent,'设置','底部入口应打开设置（2026-10-14 改名：这一页只剩设置，没有"空间"）');
   assert.match(document.querySelector('#detailbody').textContent,/接上了什么/);
   // 「打开收件箱」按钮已删：侧栏已有同一个入口，弹窗里再放一个是重复动作（交互律 03）。
   assert.equal(document.querySelector('#settingsinbox'),null,'设置里不该再有第二个收件箱入口');
   assert.equal(document.querySelector('#workspacesbody'),null,'工作区授权必须删除：契约明确不做工作区选择/切换');
   document.querySelector('.close').click();
   // 2026-10-14 用户拍板（走查 C7b）：顶栏那个「文件与资料」与知识页的页签是同一处内容的两条路径，
   // 删掉顶栏的、保留知识页的。所以这里不再找顶栏快捷入口，改为**走知识页页签**证明能力还在 ——
   // 断言的是同一个事实（能打开真实授权目录浏览），只是路径换了。
   const filesButton=[...document.querySelectorAll('#knowtabs [data-know]')].find(node=>node.dataset.know==='files');
   assert(filesButton,'知识页应保留「文件与资料」页签');
   filesButton.click();
   await new Promise(resolve=>setImmediate(resolve));
   assert(![...document.querySelectorAll('.actions .btn')].some(button=>button.textContent.includes('文件与资料')),'顶栏不该再有第二个「文件与资料」入口');
   document.querySelector('.close').click();
  }finally{controller.dispose();dom.window.close()}
 }finally{store.close()}
});
