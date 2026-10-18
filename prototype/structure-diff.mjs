import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** 结构/文案对照：把我的已部署界面与原 V7 原型（同一份演示数据）逐页比对可见文本，
 *  列出「我多出来的」与「原型有而我没有的」行。用来发现擅自增加或丢失的内容，
 *  比像素对照更能说明"改了什么"。 */

const chrome=chromeExecutable();
const workspace='w';
const pages=['home','space','projects','tasks','knowledge','personal'];

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:workspace,title:'个人空间'}],get:id=>id===workspace?{id:workspace,title:'个人空间'}:null},allowedWorkspaces:[workspace]});
 const prototype=readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8');
 const server=createServer((request,response)=>{
  if(request.url==='/prototype'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(prototype);return}
  route.handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();
 await page.setViewport({width:1440,height:940});
 const lines=async(url,view)=>{
  await page.goto(url,{waitUntil:'networkidle0'});
  await page.evaluate(name=>{const node=document.querySelector('.nav [data-view="'+name+'"]');if(node)node.click()},view);
  await new Promise(resolve=>setTimeout(resolve,600));
  return page.evaluate(()=>{
   const root=document.querySelector('.view.active')??document.body;
   const out=[];const seen=new Set();
   for(const node of root.querySelectorAll('*')){
    if(node.children.length)continue;
    const text=(node.textContent||'').replace(/\s+/g,' ').trim();
    if(!text)continue;
    const key=text;
    if(seen.has(key))continue;seen.add(key);out.push(key);
   }
   return out;
  });
 };
 const report=[];
 try{
  for(const view of pages){
   const mine=await lines(base+'/personal-workstation',view);
   const proto=await lines(base+'/prototype',view);
   const onlyMine=mine.filter(text=>!proto.includes(text));
   const onlyProto=proto.filter(text=>!mine.includes(text));
   report.push({view,onlyMine,onlyProto,mineCount:mine.length,protoCount:proto.length});
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
 return report;
}

if(process.argv[1]){
 const report=await main();
 for(const row of report){
  console.log('## '+row.view+`  （我的 ${row.mineCount} 行 / 原型 ${row.protoCount} 行）`);
  if(row.onlyMine.length){console.log('  我多出来：');for(const text of row.onlyMine.slice(0,10))console.log('    + '+text.slice(0,90))}
  if(row.onlyProto.length){console.log('  原型有而我没有：');for(const text of row.onlyProto.slice(0,10))console.log('    - '+text.slice(0,90))}
  if(!row.onlyMine.length&&!row.onlyProto.length)console.log('  一致');
 }
}
