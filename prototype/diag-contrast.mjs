import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';
const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
seedVisualStore(store);
const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'个人空间'}],get:id=>id==='w'?{id:'w',title:'个人空间'}:null},allowedWorkspaces:['w']});
const server=createServer((q,s)=>route.handler(q,s));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port+'/personal-workstation';
const browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();await page.setViewport({width:1440,height:940});
const diag=async(theme,view,selector)=>{
 await page.goto(base+(theme==='dark'?'?theme=dark':''),{waitUntil:'networkidle0'});
 if(view!=='home'){await page.evaluate(v=>document.querySelector('.nav [data-view="'+v+'"]').click(),view);await new Promise(r=>setTimeout(r,500))}
 return page.evaluate(sel=>{
  const nodes=[...document.querySelectorAll('.view.active '+sel)].slice(0,2);
  return nodes.map(node=>{
   const style=getComputedStyle(node);
   const path=[];let cur=node;
   while(cur&&cur!==document.body){const s=getComputedStyle(cur);path.push({tag:cur.tagName.toLowerCase()+(cur.className?'.'+String(cur.className).split(' ')[0]:''),bg:s.backgroundColor,color:s.color});cur=cur.parentElement}
   return {text:(node.textContent||'').trim().slice(0,20),tag:node.tagName.toLowerCase()+(node.className?'.'+String(node.className).split(' ')[0]:''),color:style.color,inline:node.getAttribute('style'),path:path.slice(0,4)};
  });
 },selector);
};
for(const [theme,view,selector] of [['light','home','.gantt .axis'],['light','tasks','.tag'],['dark','home','.taskmini small, .lower small'],['dark','tasks','h3']]){
 console.log('\n=== '+theme+' / '+view+' / '+selector);
 console.log(JSON.stringify(await diag(theme,view,selector),null,1).slice(0,900));
}
await browser.close();server.close();store.close();
