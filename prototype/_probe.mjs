import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';
const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
seedVisualStore(store);
const connection={admit:()=>({peer:{id:'o'}}),requestRejection:()=>undefined};
const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'个人空间'}],get:()=>({id:'w'})},allowedWorkspaces:['w']});
const server=createServer((q,s)=>route.handler(q,s));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();await page.setViewport({width:1440,height:940});
await page.goto('http://127.0.0.1:'+server.address().port+'/personal-workstation',{waitUntil:'networkidle0'});
await page.waitForFunction(()=>document.querySelectorAll('#projectstrip [data-project]').length>0,{timeout:15000});
const out=await page.evaluate(()=>{
 const root=getComputedStyle(document.documentElement);
 const probe=v=>{const raw=root.getPropertyValue(v);return raw===''?'∅ 未定义':raw.trim().slice(0,60)};
 const bodyCS=getComputedStyle(document.body);
 const metric=document.querySelector('.metric b');
 const surface=document.querySelector('.surface');
 const card=document.querySelector('.project');
 return {
  vars:{'--ws-font-13':probe('--ws-font-13'),'--ws-font-32':probe('--ws-font-32'),'--ws-space-24':probe('--ws-space-24'),'--ws-tint-264dad':probe('--ws-tint-264dad'),'--ws-tint-e0e5e1':probe('--ws-tint-e0e5e1'),'--ws-paper':probe('--ws-paper')},
  body:{fontSize:bodyCS.fontSize,lineHeight:bodyCS.lineHeight},
  metricNumber:metric?{text:metric.textContent.trim(),fontSize:getComputedStyle(metric).fontSize}:null,
  surfaceRadius:surface?getComputedStyle(surface).borderRadius:null,
  cardRadius:card?getComputedStyle(card).borderRadius:null,
  sheets:[...document.styleSheets].map(s=>({href:s.href?s.href.split('/').pop():'inline',rules:(()=>{try{return s.cssRules.length}catch{return 'blocked'}})()})),
  visualRulesApplied:(()=>{const s=[...document.styleSheets].find(x=>x.href&&x.href.includes('v7-visual'));if(!s)return 'v7-visual.css 未加载';try{return s.cssRules.length}catch{return 'blocked'}})(),
 };
});
console.log(JSON.stringify(out,null,2));
await browser.close();await new Promise(r=>server.close(r));store.close();
