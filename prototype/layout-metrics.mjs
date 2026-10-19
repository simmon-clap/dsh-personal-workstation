import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** 版面回归门禁（体检 P3：「日程·日历视图有 1 个元素横向溢出」）。
 *
 *  两种判据都量，且**必须分开**——这正是不做这件事时会踩的坑：
 *  A. 真溢出：元素右边界超出视口（>1px）。这是"版面被撑破"，一定是缺陷。
 *  B. 内容比容器宽：`scrollWidth - clientWidth > 1` 且该元素的 `overflow-x` 是 `visible`
 *     （即它**不**负责裁切/滚动）。这类是"内容从盒子里溢出来"，也是缺陷。
 *     反例（有意截断，不算缺陷）：`.surface{overflow:hidden}` 的卡片、
 *     `-webkit-line-clamp` 的两行截断、画布里按宽度折行的文本——它们用 overflow 明确声明了"我会裁切"。
 *
 *  固定条件：视口 1440×1100（与体检报告一致）；覆盖六个页面 + 知识五个页签 + 日程三个页签。
 *  真实数据下的实测结论写在 `发布说明.md`：报告那条在真实数据 + 1440×1100 下**复现不出**
 *  （A 判据 0），所以这里不造修复；本脚本的价值是防住**将来**的真溢出回归。
 */

const chrome=chromeExecutable();
// 两个视口都要守：桌面 1440×1100（与体检报告一致）与移动 390×844（工作台有移动布局，
// 用户主要在手机/飞书侧使用；control-audit 本来就测移动档，版面门禁不能只守桌面）。
export const VIEWPORTS=[{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}];
export const VIEWPORT=VIEWPORTS[0];
// 哪个视口"判定失败"（纳入门禁）。移动档先只量不判定：390×844 下首页路线图/甘特图确实越出视口，
// 修好并归零之后再把它改成 true——先红着接进 verify 只会让门禁长期失败，等于把门禁废掉。
// 两档都纳入强制：门禁 7 的判据是「关键页面在 1440 / 390 两档无横向溢出」。
export const ENFORCE={desktop:true,mobile:true};
// 与体检报告一致的容差：1px 以内不算溢出（亚像素取整）。
export const TOLERANCE=1;

/** 在页面里执行：返回两种判据命中的元素。 */
export function probe(scopeSelector='.view.active'){
 const scope=document.querySelector(scopeSelector)??document.body;
 const vw=document.documentElement.clientWidth;
 const hits=[];
 for(const element of scope.querySelectorAll('*')){
  const box=element.getBoundingClientRect();
  if(box.width<=0||box.height<=0)continue;
  const overflowViewport=Math.round(box.right-vw);
  const style=getComputedStyle(element);
  const inner=element.scrollWidth-element.clientWidth;
  const clips=style.overflowX!=='visible';
  // 祖先里有会裁剪或滚动的容器时，这个元素**不会把页面撑宽** ——
  // 例如 #roadmap 在窄屏是横向滚动区，里面的甘特图本来就比视口宽。
  // 门禁 7 的判据是「页面无横向溢出」，所以这种算"被容器收住"，不算页面溢出。
  const contained=(()=>{
   for(let node=element.parentElement;node&&node!==document.documentElement;node=node.parentElement){
    const parentStyle=getComputedStyle(node);
    if(parentStyle.overflowX!=='visible')return true;
    if(parentStyle.position==='fixed')return true;
   }
   return false;
  })();
  const real=overflowViewport>1&&!contained;
  const spills=!clips&&inner>1;
  if(!real&&!spills)continue;
  hits.push({
   type:real?'viewport':'spill',
   tag:element.tagName.toLowerCase(),
   cls:String(element.className||'').slice(0,60),
   id:element.id||null,
   overflowViewport,
   inner,
   overflowX:style.overflowX,
   contained,
   text:(element.textContent||'').replace(/\s+/g,' ').trim().slice(0,40),
  });
 }
 // 页面级溢出：门禁 7 的字面判据「页面无横向溢出」——必须为 0。
 return {hits,page:{overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,vw}};
}

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区',path:process.cwd()}],get:()=>({id:'w',title:'飞书工作区',path:process.cwd()})},allowedWorkspaces:['w']});
 const server=createServer((request,response)=>route.handler(request,response));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();
 const all=[],pageOverflow=[];
 try{
  for(const viewport of VIEWPORTS){
  await page.setViewport({width:viewport.width,height:viewport.height});
  await page.goto('http://127.0.0.1:'+server.address().port+'/personal-workstation',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>document.querySelectorAll('.view').length>0,{timeout:15000});
  const visit=async(label,view,tabSelector,tab)=>{
   await page.evaluate(name=>{const node=document.querySelector('.nav [data-view="'+name+'"]');if(node)node.click()},view);
   await new Promise(resolve=>setTimeout(resolve,450));
   if(tabSelector&&tab){await page.evaluate((selector,name)=>{const node=document.querySelector(selector+' [data-'+selector.replace('#','').replace('tabs','')+'="'+name+'"]');if(node)node.click()},tabSelector,tab);await new Promise(resolve=>setTimeout(resolve,450))}
   const probed=await page.evaluate(probe);
   const hits=probed.hits;
   pageOverflow.push({label,overflow:probed.page.overflow});
   for(const hit of hits)all.push({label,...hit});
   const pageBad=probed.page.overflow>1;
   const uncontained=hits.filter(hit=>!hit.contained);
   console.log(((uncontained.length||pageBad)?'FAIL':'ok  ')+' '+label+' → '+(pageBad
     ?'页面横向溢出 '+probed.page.overflow+'px'
     :`页面无横向溢出（未收住的溢出 ${uncontained.length} 个 · 被容器收住 ${hits.length-uncontained.length} 个，不计缺陷）`));
   for(const hit of hits.slice(0,5))console.log('       '+JSON.stringify(hit));
  };
  for(const view of ['home','inbox','space','projects','tasks','knowledge','personal'])await visit(viewport.name+' · '+view,view);
  for(const tab of ['topics','brief','files','memory'])await visit(viewport.name+' · knowledge · '+tab,'knowledge',null,tab);
  for(const tab of ['calendar','travel','invoice'])await visit(viewport.name+' · personal · '+tab,'personal',null,tab);
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
 const bad=[];
 console.log('');
 for(const viewport of VIEWPORTS){
  const hits=all.filter(hit=>String(hit.label).startsWith(viewport.name+' · '));
  // 只有"没有被任何容器收住"的溢出才会撑宽页面 —— 这才是门禁 7 要拦的东西。
  // 被收住的（例如窄屏里横向滚动的甘特图、SVG 里差 2px 的文字）单列，不隐藏，但不计缺陷。
  const real=hits.filter(hit=>!hit.contained);
  const designed=hits.filter(hit=>hit.contained);
  const enforced=ENFORCE[viewport.name]===true;
  console.log((real.length&&enforced?'FAIL':'ok  ')+' '+viewport.name+' '+viewport.width+'×'+viewport.height
   +' → 真溢出 '+real.length+' 个（'+(enforced?'阈值 0，纳入门禁':'**未纳入门禁**：待修复后再纳入')+'）'
   +' · 设计内截断 '+designed.length+' 个（不计缺陷）');
  for(const hit of real.slice(0,6))console.log('       '+JSON.stringify(hit));
  const labels=all.filter(hit=>String(hit.label).startsWith(viewport.name+' · ')).map(hit=>hit.label);
  const worstPage=pageOverflow.filter(row=>labels.includes(row.label)).reduce((max,row)=>Math.max(max,row.overflow),0);
  console.log('     （页面级横向溢出最大值 '+worstPage+'px —— 这才是门禁 7 的字面判据）');
  if(enforced&&real.length)bad.push(...real);
  if(enforced&&worstPage>1)bad.push({type:'page',label:viewport.name+' 页面本身',overflowViewport:worstPage});
 }
 const enforcedHits=all.filter(hit=>ENFORCE[VIEWPORTS.find(v=>String(hit.label).startsWith(v.name+' · '))?.name]===true);
 console.log('');
 console.log(bad.length?('FAIL: 发现 '+bad.length+' 处真实横向溢出：\n'+bad.map(hit=>'  · ['+hit.type+'] '+hit.label+' '+hit.tag+(hit.cls?'.'+hit.cls:'')+' 越界 '+hit.overflowViewport+'px / 内容多 '+hit.inner+'px · '+hit.text).join('\n'))
  :('PASS: 纳入门禁的视口无横向溢出（判定项 '+enforcedHits.length+' 个命中；未纳入的视口已在上面逐项列出）。'));
 process.exitCode=bad.length?1:0;
}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop()))await main();
