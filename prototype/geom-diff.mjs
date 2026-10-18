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

/** 逐元素几何对照：把已部署界面与设计方 VI 应用页在同一视口下逐项量出来。
 *  像素差异只能说明"有差别"，这个脚本说明"差在哪个元素、差多少"。 */

const chrome=chromeExecutable();

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'个人空间'}],get:id=>id==='w'?{id:'w',title:'个人空间'}:null},allowedWorkspaces:['w']});
 const designRoot=fileURLToPath(new URL('../../design-system/',import.meta.url));
 const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.js':'text/javascript'};
 const server=createServer((request,response)=>{
  if(request.url.startsWith('/design/')){
   const target=join(designRoot,decodeURIComponent(request.url.slice('/design/'.length).split('?')[0]));
   if(!target.startsWith(designRoot)||!existsSync(target)){response.writeHead(404);response.end('nf');return}
   response.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream'});response.end(readFileSync(target));return;
  }
  route.handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();
 await page.setViewport({width:1440,height:940});
 const measure=async(url,view)=>{
  await page.goto(url,{waitUntil:'networkidle0'});
  if(view!=='home'){await page.evaluate(name=>{const node=document.querySelector('.nav [data-view="'+name+'"]');if(node)node.click()},view);await new Promise(r=>setTimeout(r,600))}
  return page.evaluate(()=>{
   const box=selector=>{const node=document.querySelector(selector);if(!node)return null;const b=node.getBoundingClientRect();return {top:Math.round(b.top),left:Math.round(b.left),w:Math.round(b.width),h:Math.round(b.height)}};
   const css=(selector,property)=>{const node=document.querySelector(selector);return node?getComputedStyle(node)[property]:null};
   return {
    doc:document.documentElement.scrollHeight,
    topBar:box('.top'),topHeight:css('.top','height'),
    navFirst:box('.nav button'),navItemHeight:css('.nav button','height'),navItemPad:css('.nav button','padding'),
    brand:box('.brand'),brandSize:css('.brand','fontSize'),
    breadcrumb:box('#subtitle'),crumbSize:css('#subtitle','fontSize'),
    hero:box('.spaceentry'),heroPad:css('.spaceentry','padding'),
    firstMetric:box('#metrics .metric'),metricCount:document.querySelectorAll('#metrics .metric').length,
    metricPad:css('#metrics .metric','padding'),metricRadius:css('#metrics .metric','borderRadius'),
    sectionHead:box('#home .sectionhead'),firstCard:box('#projectstrip .project'),
    roadmap:box('#roadmap'),lower:box('#home .lower'),
    // 画布：参考页是静态快照，需要知道它当时的缩放与是否画了关系文字，才能解释差异。
    canvasZoom:(document.querySelector('#zoomlabel')?.textContent||'').trim()||null,
    canvasNodes:document.querySelectorAll('#spaceSvg [data-node], #spaceSvg .graphnode').length,
    canvasEdgeLabels:document.querySelectorAll('#spaceSvg .graphlabel').length,
   };
  });
 };
 try{
  const mine=await measure(base+'/personal-workstation','home');
  const design=await measure(base+'/design/V7-视觉应用.html','home');
  const mineSpace=await measure(base+'/personal-workstation','space');
  const designSpace=await measure(base+'/design/V7-视觉应用.html','space');
  console.log('  画布对照  我='+JSON.stringify({zoom:mineSpace.canvasZoom,nodes:mineSpace.canvasNodes,edgeLabels:mineSpace.canvasEdgeLabels})+'  设计方='+JSON.stringify({zoom:designSpace.canvasZoom,nodes:designSpace.canvasNodes,edgeLabels:designSpace.canvasEdgeLabels}));
  const keys=Object.keys(mine);
  const rows=[];
  for(const key of keys){
   const a=mine[key],b=design[key];
   const same=JSON.stringify(a)===JSON.stringify(b);
   rows.push({key,mine:a,design:b,same});
  }
  return rows;
 }finally{await browser.close();await new Promise(r=>server.close(r));store.close()}
}

if(process.argv[1]){
 const rows=await main();
 let diffs=0;
 for(const row of rows){
  if(row.same){console.log('  = '+row.key+' '+JSON.stringify(row.mine));continue}
  diffs+=1;
  console.log('  ≠ '+row.key+'  我='+JSON.stringify(row.mine)+'  设计方='+JSON.stringify(row.design));
 }
  console.log('\n共 '+rows.length+' 项，改动 '+diffs+' 项');
  // 2026-10-14 修正（用户点名「字体太大 / 整体显老」时查出的门禁失效）：
  // ① 原判据 `typeof a==='number'?…:a&&b?Math.abs(a.top-b.top):0` 有 bug ——
  //    topHeight/navItemHeight/brandSize/crumbSize 是 getComputedStyle 返回的**字符串**，
  //    走 else 分支得 Math.abs(undefined-undefined)=NaN，而 NaN>2 恒假 ⇒ 这 4 个锚点形同虚设。
  //    实测品牌 18px vs 16px、页头小字 11px vs 10px 明明不同，却从不报错。
  // ② 锚点必须分两类。参考页 `design-system/V7-视觉应用.html` 是从**冻结原型**生成的，
  //    它自己的字号（品牌 16px、页头小字 10px）并不在 VI 字阶内（11/12/13/14/15/18/22/32）。
  //    VI §13 门禁 12「精确重建」与门禁 2/3「标尺外像素=0 / 字阶外字号=0」在这几处无法同时成立；
  //    用户 2026-10-13 已拍板「VI 优先」，故：
  //      · 契约锚点（布局度量：栏高、内边距、圆角）必须一致 —— 它们是信息架构，与字阶无关；
  //      · 排版锚点（由字号/行高驱动的高度）只**列明差值**，不再伪装成"完全一致"。
  const contractAnchors=['topHeight','navItemPad','metricPad','metricRadius','heroPad','topBar'];
  const typographicAnchors=['navItemHeight','brandSize','crumbSize','firstMetric','sectionHead','firstCard','roadmap'];
  const drifted=[],typed=[];
  for(const row of rows){
   const a=row.mine,b=row.design;
   const delta=(Number.isFinite(Number.parseFloat(a))&&Number.isFinite(Number.parseFloat(b)))
    ?Math.abs(Number.parseFloat(a)-Number.parseFloat(b))
    :(a&&b&&Number.isFinite(a.top)&&Number.isFinite(b.top)?Math.abs(a.top-b.top):null);
   if(contractAnchors.includes(row.key)){
    if(delta===null)drifted.push(row.key+' 无法比较');
    else if(delta>2)drifted.push(row.key+' 相差 '+delta+'px');
   }else if(typographicAnchors.includes(row.key)){
    if(delta===null||delta>2)typed.push(row.key+' 相差 '+(delta===null?'?':delta)+'px');
   }
  }
  if(typed.length)console.log('说明：以下锚点与参考页有差异，属**字阶入档后的有意偏离**（参考页自身字号不在 VI 字阶内，用户已拍板 VI 优先）：'+typed.join('；'));
  if(drifted.length){console.log('FAIL: 首页布局契约锚点与参考页不一致：'+drifted.join('；'));process.exit(1)}
  console.log('PASS: 首页布局契约锚点与设计方参考页一致（误差 ≤2px）；排版差异已逐项列明，不再谎报"完全一致"。');
}
