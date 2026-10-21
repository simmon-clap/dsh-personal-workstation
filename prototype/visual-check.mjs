import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,extname} from 'node:path';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

// 仅用于逐页视觉/交互验收：内存库 + 与原型相同形状的数据。
// 这个脚本不进入发布包，也不写任何生产数据库。
const chrome=chromeExecutable();
const workspace='w';
const pages=['home','space','projects','tasks','knowledge','personal'];
const viewports=[{name:'desktop',width:1440,height:940},{name:'mobile',width:390,height:844}];

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:workspace,title:'个人空间'}],get:id=>id===workspace?{id:workspace,title:'个人空间'}:null},allowedWorkspaces:[workspace]});
 const prototype=readFileSync(new URL('./frozen/workbench-v7.html',import.meta.url),'utf8');
 // 「纸上秩序」设计方自己的 V7 视觉应用页，作为逐页对照基准。
 const designRoot=fileURLToPath(new URL('../design-system/',import.meta.url));
 const designTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
 const server=createServer((request,response)=>{
  if(request.url==='/prototype'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(prototype);return}
  if(request.url.startsWith('/design/')){
   const target=join(designRoot,decodeURIComponent(request.url.slice('/design/'.length).split('?')[0]));
   if(!target.startsWith(designRoot)||!existsSync(target)){response.writeHead(404);response.end('Not found');return}
   response.writeHead(200,{'content-type':designTypes[extname(target)]||'application/octet-stream'});response.end(readFileSync(target));return;
  }
  route.handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const directory=fileURLToPath(new URL('./screenshots/',import.meta.url));mkdirSync(directory,{recursive:true});
 const report={};
 try{
  const sources=[['v7','http://127.0.0.1:'+port+'/personal-workstation'],['prototype','http://127.0.0.1:'+port+'/prototype'],['design','http://127.0.0.1:'+port+'/design/V7-视觉应用.html']];
  // 深色：只对可跟随 Host 主题的已部署界面取图。
  if(process.env.V7_DARK)sources.push(['v7-dark','http://127.0.0.1:'+port+'/personal-workstation?theme=dark']);
  for(const viewport of viewports)for(const [source,url]of sources){
   const key=source+'-'+viewport.name;
   const page=await browser.newPage();await page.setViewport({width:viewport.width,height:viewport.height,deviceScaleFactor:1});
   const errors=[];page.on('pageerror',error=>errors.push('pageerror: '+error.message));
   page.on('console',message=>{if(message.type()==='error'&&!/Failed to load resource/.test(message.text()))errors.push('console: '+message.text())});
   page.on('response',response=>{if(response.status()>=400&&!/favicon\.ico$/.test(response.url()))errors.push('http '+response.status()+' '+response.url())});
   report[key]={errors:[],pages:{}};
   await page.goto(url,{waitUntil:'networkidle0'});
   for(const name of pages){
    await page.evaluate(target=>{const button=document.querySelector('.nav [data-view="'+target+'"]');if(!button)throw new Error('缺少导航入口 '+target);button.click()},name);
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.screenshot({path:join(directory,source+'-'+name+'-'+viewport.name+'.png')});
    report[key].pages[name]=await page.evaluate(()=>{
     const active=document.querySelector('.view.active');
     const box=active?active.getBoundingClientRect():null;
     // 只统计真正被裁掉的元素：位于可横向滚动祖先内的溢出是设计意图（例如甘特图在卡片内滚动）。
     const scrollable=element=>{for(let node=element.parentElement;node&&node!==document.body;node=node.parentElement){const overflow=getComputedStyle(node).overflowX;if(overflow==='auto'||overflow==='scroll')return true}return false};
     const overflowing=[...document.querySelectorAll('.view.active *,.top *,.nav *')].filter(element=>{const rect=element.getBoundingClientRect();return rect.width>0&&(rect.right>window.innerWidth+1||rect.left<-1)&&!scrollable(element)}).length;
     return {view:active?.id??null,children:active?.children.length??0,width:Math.round(box?.width??0),height:Math.round(box?.height??0),pageOverflow:document.documentElement.scrollWidth-window.innerWidth,overflowing,text:(active?.innerText??'').replace(/\s+/g,' ').trim().slice(0,120)};
    });
   }
   report[key].errors=errors;await page.close();
  }
 }finally{
  await browser.close();server.close();store.close();
 }
 writeFileSync(new URL('./screenshots/report.json',import.meta.url),JSON.stringify(report,null,2));
 for(const [key,value]of Object.entries(report)){
  console.log(key,'errors='+JSON.stringify(value.errors));
  for(const [page,info]of Object.entries(value.pages))console.log(' ',page.padEnd(10),'children='+info.children,'overflow='+info.pageOverflow,'clipped='+info.overflowing,'h='+info.height);
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
