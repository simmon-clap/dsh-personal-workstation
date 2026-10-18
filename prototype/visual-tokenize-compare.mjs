/**
 * 批次 5 · 第二段受控对照：`src/v7/v7-visual.css` 的字面值收敛。
 *
 * 疑问：这 38 处色值是「纸上秩序」覆盖层里的**自定色**（#f1f3f1 / #e2e6e2 / #e5ebe9 …），
 * 它们该映射到 VI token（会动视觉），还是属于**这一层自己的调色板**（值不变、只换变量写法）？
 * 答案不许靠感觉 —— 用真实浏览器逐页量，与同页抖动基线对照。
 *
 * 用法：node prototype/visual-tokenize-compare.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {tokenizeCss} from './shell-tokenize.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome=chromeExecutable();
const pages=['home','space','projects','tasks','knowledge','personal'];
const viewport={width:1440,height:940};

const v7Root=fileURLToPath(new URL('../src/v7/',import.meta.url));
const visual=readFileSync(join(v7Root,'v7-visual.css'),'utf8');
const mapped=tokenizeCss(visual,{colorDistance:256,spaceTolerance:0,fontTolerance:0,spacing:false,fontSize:false});
const exact=tokenizeCss(visual,{colorDistance:256,spacing:'exact',fontSize:false});
const hex=s=>(s.match(/#[0-9a-fA-F]{3,8}\b/g)??[]).length;
const variants={
 original:visual,
 mapped:mapped.css,                                      // 色值 → 最近 VI token（可能位移）
 exact:exact.css+'\n'+layerOf(exact.definitions),        // 色值/间距 → 同值变量（零位移）
};
function layerOf(definitions){return Object.keys(definitions).length?':root{\n'+Object.entries(definitions).map(([k,v])=>`  ${k}:${v};`).join('\n')+'\n}':'';}
console.log('v7-visual.css 色值字面量',hex(visual),'→ mapped 剩',hex(variants.mapped),'· exact 剩',hex(variants.exact));
console.log('色值映射举例：',Object.entries(mapped.report.colors).slice(0,6).map(([k,v])=>k+'→'+v.to).join('  '));

const store=new WorkstationStore(':memory:');
seedVisualStore(store);
const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
const route=httpRoute({store,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区'}],get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null},allowedWorkspaces:['w']});
const types={'.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.png':'image/png','.json':'application/json'};
let served='original';
const server=createServer((request,response)=>{
 const url=request.url.split('?')[0];
 if(url.startsWith('/personal-workstation/v7/')){
  const name=url.slice('/personal-workstation/v7/'.length);
  if(name==='v7-visual.css'){response.writeHead(200,{'content-type':'text/css; charset=utf-8'});response.end(variants[served]);return}
  const target=join(v7Root,name);
  if(!target.startsWith(v7Root)||!existsSync(target)){response.writeHead(404);response.end('Not found');return}
  response.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream'});response.end(readFileSync(target));return;
 }
 route.handler(request,response);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const directory=fileURLToPath(new URL('./screenshots/visual/',import.meta.url));mkdirSync(directory,{recursive:true});
const shots={};
try{
 const page=await browser.newPage();
 await page.setViewport(viewport);
 const shoot=async(mode,view,pass)=>{
  served=mode;
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  await page.evaluate(name=>{document.querySelector('.nav [data-view="'+name+'"]')?.click();window.scrollTo(0,0)},view);
  await new Promise(resolve=>setTimeout(resolve,600));
  const buffer=await page.screenshot();
  writeFileSync(join(directory,`${mode}${pass??''}-${view}.png`),buffer);
  return buffer;
 };
 const diff=async(aUrl,bUrl,tolerance)=>{
  return page.evaluate(async(a,b,tol)=>{
   const load=src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src});
   const [x,y]=await Promise.all([load(a),load(b)]);
   const w=Math.min(x.width,y.width),h=Math.min(x.height,y.height);
   const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});
   ctx.drawImage(x,0,0);const L=ctx.getImageData(0,0,w,h).data;
   ctx.clearRect(0,0,w,h);ctx.drawImage(y,0,0);const R=ctx.getImageData(0,0,w,h).data;
   let differing=0,worst=0;
   for(let i=0;i<L.length;i+=4){const d=Math.max(Math.abs(L[i]-R[i]),Math.abs(L[i+1]-R[i+1]),Math.abs(L[i+2]-R[i+2]));if(d>worst)worst=d;if(d>tol)differing++;}
   return {ratio:differing/(w*h),worst};
  },`data:image/png;base64,${aUrl.toString('base64')}`,`data:image/png;base64,${bUrl.toString('base64')}`,8);
 };
 console.log('页面'.padEnd(10),'同页抖动'.padEnd(10),'mapped'.padEnd(10),'exact');
 for(const view of pages){
  const a=await shoot('original',view);
  const a2=await shoot('original',view,'2');
  const m=await shoot('mapped',view);
  const e=await shoot('exact',view);
  const jitter=await diff(a,a2);
  const dm=await diff(a,m);
  const de=await diff(a,e);
  shots[view]={jitter:jitter.ratio,mapped:dm.ratio,exact:de.ratio,mappedWorst:dm.worst,exactWorst:de.worst};
  console.log(view.padEnd(10),(jitter.ratio*100).toFixed(2)+'%'.padEnd(6),(dm.ratio*100).toFixed(2)+'%'.padEnd(6),(de.ratio*100).toFixed(2)+'%'.padEnd(6),'(最大差 mapped '+dm.worst+' · exact '+de.worst+')');
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
const worst=k=>Math.max(...Object.values(shots).map(row=>row[k]));
console.log('─'.repeat(64));
console.log('最大：mapped '+(worst('mapped')*100).toFixed(2)+'% · exact '+(worst('exact')*100).toFixed(2)+'% · 抖动基线 '+(worst('jitter')*100).toFixed(2)+'%');
process.exit(0);
