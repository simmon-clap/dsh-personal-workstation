import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {mountV7} from '../prototype/v7-controller-v6.mjs';
import {visualSeedChanges} from '../prototype/visual-seed.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';

const pages=['home','space','projects','tasks','knowledge','personal'];
// 已接入点击委派的容器，与 prototype/control-audit.mjs 保持一致。
const delegatedRoots=['#knowbody','#personalbody','#detailbody','#home .lower','#spaceSvg','#roadtabs','#tasktabs','#taskfilters','#projecttabs','#personaltabs','#knowtabs','#inboxfilters','#projectsbody','#projectstrip','#roadmap','#tasksbody','#taskmini','#metrics'];
const delegatedAttributes=['data-view','data-goto','data-road','data-pmode','data-tmode','data-target','data-know','data-personal','data-kind','data-batch','data-inbox'];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function bridge(store,executions){
 const route=browserRoute({store,executions,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(url,options={})=>{const response=await route.fetch(new Request('http://localhost'+url,{method:options.method??'GET',headers:options.headers,body:options.body}));return response};
}
test('every control in the live V7 shell has a real handler on all six pages and their tabs',async()=>{
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 const ctx={workspace:'w',actor:'t',canWrite:true};const batch=store.draft(ctx,{title:'seed',changes:visualSeedChanges()});store.commit(ctx,{batchId:batch.id,revision:1,key:'seed'});
 const dom=new JSDOM(readFileSync(new URL('../src/v7-shell.html',import.meta.url),'utf8')),document=dom.window.document;
 const controller=await mountV7(document,{workspace:'w',fetch:bridge(store,executions),onError:error=>{throw error},notify:()=>{},confirm:()=>true});
 try{
  const dead=[];
  const audit=label=>{
   const scopes=[document.querySelector('.nav'),document.querySelector('.top'),document.querySelector('.hero'),document.querySelector('.view.active')].filter(Boolean);
   for(const scope of scopes)for(const element of scope.querySelectorAll('button,select,input,a[href]')){
    if(element.disabled)continue;
    const handled=element.onclick!==null||element.onchange!==null||element.oninput!==null||element.onkeydown!==null
     ||delegatedRoots.some(selector=>element.closest(selector))||delegatedAttributes.some(attribute=>element.hasAttribute(attribute));
    if(!handled)dead.push(label+' · '+(element.id||element.textContent.replace(/\s+/g,' ').trim().slice(0,24)||element.className));
   }
  };
  for(const name of pages){
   controller.navigation.show(name);await tick();audit(name);
   // 二级标签也要审：只审默认标签会漏掉「知识 · 收件箱」这类标签内的控件。
   for(const tab of document.querySelectorAll('.view.active [data-know],.view.active [data-personal],.view.active [data-pmode],.view.active [data-tmode]')){
    tab.click();await tick();await tick();audit(name+' · '+tab.textContent.trim());
   }
  }
  assert.deepEqual(dead,[],'以下可见控件在真实数据下没有处理函数：\n'+dead.join('\n'));
 }finally{controller.dispose();store.close();dom.window.close()}
});
test('the seeded verification fixture never reaches the published V7 tree',()=>{
 const published=readFileSync(new URL('../src/v7/v7-controller-v6.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(published,/visualSeed|visual-seed|联合验证|场景探索/,'发布模块不得包含验收种子数据');
 const names=readFileSync(new URL('../src/v7-assets.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(names,/visual-check|control-audit|visual-seed|screenshots/,'验收脚本不得进入发布路由清单');
});
