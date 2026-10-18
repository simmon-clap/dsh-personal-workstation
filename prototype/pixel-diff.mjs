import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {extname,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';
// 脚本自己的目录（写基线/读基线用）—— 放在 import 之后，避免"声明在 import 之间"这种脆弱写法。
const here=dirname(fileURLToPath(import.meta.url));

/** 与设计方「V7-视觉应用」页逐页像素对照：同样的数据与视口下，量化差异并给出差异热点。
 *  这是回答「有没有完全按 VI 实现」最客观的方式——不靠肉眼，也不靠"看起来差不多"。 */

const chrome=chromeExecutable();
const workspace='w';
const pages=['home','space','projects','tasks','knowledge','personal'];
const viewport={width:1440,height:940};
// 每格 1/36 宽、1/24 高：用来定位差异集中在哪些区域。
const GRID={columns:36,rows:24};
const TOLERANCE=24;

/**
 * 判决（纯函数，可单测）：比基线更差 → 返回回归清单。
 * 抽出来是因为 45 审计抓过一处「把 0–1 的比例和 0–255 的像素容差混用、判断永不 FAIL」的事故；
 * 光看代码很难证明棘轮有效，写成纯函数才能在 test/ 里注入一条"更差"的测量值做 canary。
 */
export function verdict(rows, baselinePages = {}, tolerance = 0.005) {
 const regressed = [];
 for (const row of rows) {
  const was = baselinePages?.[row.view];
  if (typeof was !== 'number') { regressed.push(row.view + '（基线里没有这一页）'); continue; }
  if (row.best.ratio > was + tolerance) regressed.push(row.view + ' ' + (was * 100).toFixed(2) + '% → ' + (row.best.ratio * 100).toFixed(2) + '%');
 }
 return regressed;
}

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:workspace,title:'个人空间'}],get:id=>id===workspace?{id:workspace,title:'个人空间'}:null},allowedWorkspaces:[workspace]});
 const designRoot=fileURLToPath(new URL('../../design-system/',import.meta.url));
 const designTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
 const server=createServer((request,response)=>{
  if(request.url.startsWith('/design/')){
   const target=join(designRoot,decodeURIComponent(request.url.slice('/design/'.length).split('?')[0]));
   if(!target.startsWith(designRoot)||!existsSync(target)){response.writeHead(404);response.end('Not found');return}
   response.writeHead(200,{'content-type':designTypes[extname(target)]||'application/octet-stream'});response.end(readFileSync(target));return;
  }
  route.handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const directory=fileURLToPath(new URL('./screenshots/',import.meta.url));mkdirSync(directory,{recursive:true});
 const results=[];
 try{
  const page=await browser.newPage();
  await page.setViewport(viewport);
  const shoot=async(url,view)=>{
   const errors=[];
   const onError=error=>errors.push(error.message);
   page.on('pageerror',onError);
   await page.goto(url,{waitUntil:'networkidle0'});
   await page.evaluate(name=>{const button=document.querySelector('.nav [data-view="'+name+'"]');if(button)button.click();window.scrollTo(0,0)},view);
   await new Promise(resolve=>setTimeout(resolve,600));
   const buffer=await page.screenshot({type:'png'});
   page.off('pageerror',onError);
   return {buffer,errors};
  };
  for(const view of pages){
   const mine=await shoot(base+'/personal-workstation',view);
   const design=await shoot(base+'/design/V7-视觉应用.html',view);
   // 在浏览器里逐像素比较：无需额外图像库，也避免把 PNG 解码逻辑写进脚本。
   const diff=await page.evaluate(async(mineUrl,designUrl,grid,tolerance)=>{
    const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片加载失败'));image.src=src});
    const [a,b]=await Promise.all([load(mineUrl),load(designUrl)]);
    const width=Math.min(a.width,b.width),height=Math.min(a.height,b.height);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(a,0,0);const left=context.getImageData(0,0,width,height).data;
    context.clearRect(0,0,width,height);context.drawImage(b,0,0);const right=context.getImageData(0,0,width,height).data;
    // 先分离两件事：整体纵向偏移（版式节奏）与对齐后仍存在的差异（样式/内容）。
    // 不分离的话，几像素的位移会让所有文字边缘都算作「不同」，指标就没有意义。
    const ratioAt=(dy,dx)=>{
     let differing=0,counted=0;
     for(let y=0;y<height;y+=1){
      const sy=y+dy;if(sy<0||sy>=height)continue;
      for(let x=0;x<width;x+=2){
       const sx=x+dx;if(sx<0||sx>=width)continue;
       const i=(y*width+x)*4,j=(sy*width+sx)*4;
       const delta=Math.max(Math.abs(left[i]-right[j]),Math.abs(left[i+1]-right[j+1]),Math.abs(left[i+2]-right[j+2]));
       counted+=1;if(delta>tolerance)differing+=1;
      }
     }
     return differing/Math.max(1,counted);
    };
    let best={ratio:ratioAt(0,0),dy:0,dx:0};
    for(let dy=-60;dy<=60;dy+=2)for(const dx of [0,-8,8,-16,16]){
     const ratio=ratioAt(dy,dx);
     if(ratio<best.ratio)best={ratio,dy,dx};
    }
    const cells=Array.from({length:grid.rows},()=>new Array(grid.columns).fill(0));
    const totals=Array.from({length:grid.rows},()=>new Array(grid.columns).fill(0));
    let differing=0;
    const overlay=context.createImageData(width,height);
    for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){
     const index=(y*width+x)*4;
     const sy=y+best.dy,sx=x+best.dx;
     const other=(sy>=0&&sy<height&&sx>=0&&sx<width)?(sy*width+sx)*4:index;
     const delta=Math.max(Math.abs(left[index]-right[other]),Math.abs(left[index+1]-right[other+1]),Math.abs(left[index+2]-right[other+2]));
     const row=Math.min(grid.rows-1,Math.floor(y*grid.rows/height)),column=Math.min(grid.columns-1,Math.floor(x*grid.columns/width));
     totals[row][column]+=1;
     const bad=delta>tolerance;
     if(bad){differing+=1;cells[row][column]+=1}
     overlay.data[index]=bad?255:left[index];overlay.data[index+1]=bad?0:left[index+1];overlay.data[index+2]=bad?0:left[index+2];overlay.data[index+3]=255;
    }
    const canvasOut=document.createElement('canvas');canvasOut.width=width;canvasOut.height=height;
    canvasOut.getContext('2d').putImageData(overlay,0,0);
    const hot=[];
    for(let row=0;row<grid.rows;row+=1)for(let column=0;column<grid.columns;column+=1){
     const ratio=cells[row][column]/totals[row][column];
     if(ratio>0.35)hot.push({x:Math.round(column*100/grid.columns),y:Math.round(row*100/grid.rows),ratio:Math.round(ratio*100)});
    }
    hot.sort((a,b)=>b.ratio-a.ratio);
    return {width,height,differing,total:width*height,overlay:canvasOut.toDataURL('image/png'),hot:hot.slice(0,6),raw:ratioAt(0,0),best};
   },`data:image/png;base64,${mine.buffer.toString('base64')}`,`data:image/png;base64,${design.buffer.toString('base64')}`,GRID,TOLERANCE);
   const name='diff-'+view+'.png';
   writeFileSync(join(directory,name),Buffer.from(diff.overlay.split(',')[1],'base64'));
   results.push({view,differing:diff.differing,total:diff.total,ratio:diff.differing/diff.total,raw:diff.raw,best:diff.best,hot:diff.hot,errors:[...mine.errors,...design.errors],file:name});
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
 return results;
}

if(process.argv[1]&&process.argv[1]===fileURLToPath(import.meta.url)){
 const results=await main();
 let worst=0;
 for(const row of results){
  worst=Math.max(worst,row.ratio);
  console.log(row.view.padEnd(10)
   +'未对齐 '+(row.raw*100).toFixed(2)+'%'
   +'  最佳对齐(dy '+String(row.best.dy).padStart(3)+', dx '+String(row.best.dx).padStart(3)+') 后 '+(row.best.ratio*100).toFixed(2)+'%'
   +'  热点 '+JSON.stringify(row.hot)
   +(row.errors.length?'  错误 '+JSON.stringify(row.errors):''));
 }
 console.log('\n对照图（改动为红色）写入 prototype/screenshots/diff-*.png');

 // ── 判决口径（2026-10-16 改）──────────────────────────────────────────────
 // 原来是一刀切的 2% 阈值。但用户 2026-10-10 已拍板「**VI 优先，允许按纸上秩序改结构**」，
 // 之后字阶入档、圆角、间距、去页头口号等都是**有意偏离**设计方那一页 ——
 // 在这种前提下，"像素差必须 <2%" 这个判决本身就没有意义了（永远红，红了就没人看）。
 //
 // 但也不该因此把它扔掉：它是一个能发现"又漂了"的客观量。所以改成**棘轮**（与 charter-guard 同一套）：
 //   · 比基线更差（超过容差）→ FAIL，并指出是哪一页、差多少；
 //   · 比基线更好 → PASS，并提示可以把基线收紧（不自动改写 —— 自动改写等于把棘轮拆了）。
 const baselineFile=join(here,'..','..','spec','pixel-baseline.json');   // 规范在仓库根 spec/（与 spec-coverage-audit 同一处）
 const TOLERANCE=0.005;   // 0.5 个百分点：留出渲染噪声的余量，但不允许持续漂移
 let baseline=null;
 try{baseline=JSON.parse(readFileSync(baselineFile,'utf8'))}catch{}
 if(!baseline||!baseline.pages){
  console.log('（没有基线，本次只报数不判决；把本次结果写进 '+baselineFile+' 即可开始棘轮）');
  console.log('本次逐页：'+results.map(r=>r.view+' '+(r.best.ratio*100).toFixed(2)+'%').join(' · '));
  process.exit(0);
 }
 const regressed=verdict(results,baseline.pages,TOLERANCE);
 console.log('（这些差异里含**已拍板的有意偏离**：VI 优先、字阶入档、去页头口号等；'
  +'所以这里不比"与设计方一模一样"，只比"有没有比基线更差"。值是否符合 VI 由 style-check / craft-audit / type-scale-audit 管。）');
 console.log('本次最大改动 '+(worst*100).toFixed(2)+'% · 基线最大 '+((Math.max(...Object.values(baseline.pages)))*100).toFixed(2)+'%');
 if(regressed.length){
  console.log('FAIL: 有页面比基线更差（容差 '+(TOLERANCE*100).toFixed(1)+' 个百分点）：');
  for(const row of regressed)console.log('  · '+row);
  console.log('  改法：看 prototype/screenshots/diff-*.png 的热点，确认是"又漂了"还是"有意改的"；');
  console.log('        确实是有意改的，再把 spec/pixel-baseline.json 里对应页收紧（收紧要有理由）。');
  process.exit(1);
 }
 console.log('PASS: 六页都没有比基线更差（这不代表与设计方一致，只代表没有继续漂）。');
 process.exit(0);
}
