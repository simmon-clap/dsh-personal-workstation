import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** VI 计算样式校验：在真实 Chrome 里读 getComputedStyle，
 *  证明几何与配色**实际生效**，而不只是样式表里写了这些值（层叠或覆盖都可能让它失效）。
 *  浏览器无法证明的条目（对比度、字标转曲等）不在此断言，仍由账本人工留证。 */

const DESKTOP={width:1440,height:940},MOBILE={width:390,height:844};
export async function runStyleCheck(){
 const store=new WorkstationStore(':memory:');
 // 必须播种：否则页面是空的，逐节点对比度扫描会在空页面上"全部通过"（空转检查）。
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区'}],get:id=>id==='w'?{id:'w',title:'飞书工作区'}:null},allowedWorkspaces:['w']});
 const server=createServer((q,s)=>route.handler(q,s));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const findings={checks:[],failures:[]};
 const check=(name,actual,expected)=>{
  const ok=typeof expected==='function'?expected(actual):actual===expected;
  findings.checks.push({name,actual,ok});
  if(!ok)findings.failures.push(name+'：实际 '+JSON.stringify(actual));
 };
 try{
  const page=await browser.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.setViewport(DESKTOP);
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  const desktop=await page.evaluate(()=>{
   const px=value=>Math.round(Number.parseFloat(value));
   const nav=document.querySelector('.nav'),top=document.querySelector('.top'),main=document.querySelector('main'),surface=document.querySelector('.surface');
   const primary=[...document.querySelectorAll('.top .actions .btn.primary')];
   return {
    navWidth:px(getComputedStyle(nav).width),
    topHeight:px(getComputedStyle(top).height),
    mainPaddingLeft:px(getComputedStyle(main).paddingLeft),
    surfaceRadius:px(getComputedStyle(surface).borderRadius),
    primaryCount:primary.length,
    primaryLabel:primary[0]?.textContent?.trim()??null,
    createIsSecondary:!document.querySelector('.top #create').classList.contains('primary'),
    intakeRemoved:[...document.querySelectorAll('.top .actions button')].filter(node=>/录入/.test(node.textContent)).length===0,
    bodyBackground:getComputedStyle(document.body).backgroundColor,
    paperBackground:getComputedStyle(document.querySelector('.nav')).backgroundColor,
    brandViewBox:document.querySelector('.brandmark svg')?.getAttribute('viewBox')??null,
    brandWidth:px(getComputedStyle(document.querySelector('.brandmark svg')).width),
    // VI-1 禁止的是「页头大标题」这个视觉元素；W2-1 给页面标题补的隐藏 h1 是无障碍语义，
    // 不渲染、不占位（用户 2026-10-10 已拍板不要页头口号）。所以只数可见的。
    topHeadings:[...document.querySelectorAll('.top h1,.top h2,.top h3')].filter(el=>{const r=el.getBoundingClientRect();return r.width>1&&r.height>1}).length,
    subtitleSize:px(getComputedStyle(document.querySelector('#subtitle')).fontSize),
   };
  });
  check('VI-2 侧栏 204px',desktop.navWidth,204);
  check('VI-2 顶栏 76px',desktop.topHeight,76);
  check('VI-2 页边距 32px',desktop.mainPaddingLeft,32);
  check('VI-2 内容容器圆角 12px',desktop.surfaceRadius,12);
  // 2026-10-14：顶栏原来有两个创建入口（录入 / 新建），用户点名重复；现在只留「新建」，
  // 它因此成为顶栏唯一主按钮（VI V4）。门禁跟着改口径，不是放宽：仍然要求"恰好一个"。
  check('VI-3 顶栏主按钮只有一个',desktop.primaryCount,1);
  check('VI-3 顶栏主按钮是「新建」',desktop.primaryLabel,v=>typeof v==='string'&&v.includes('新建'));
  check('VI-3 顶栏不再有第二个创建入口',desktop.intakeRemoved,true);
  check('VI-1 页头无标题元素',desktop.topHeadings,0);
  // 2026-10-17：VI §3 规定 11px **只用于时间/坐标**；页头提示属辅助信息，应走辅助档 12px。
  // 这里改的是**口径向规范靠**，不是放宽：仍然要求"是小字"（≤12），但不许再用 11 冒充小字。
  check('VI-1 页头提示为辅助档小字（12px；11 只留时间/坐标）',desktop.subtitleSize,v=>v===12);
  check('VI 品牌区用 VI 标识',desktop.brandViewBox,'0 0 52 52');
  check('VI 品牌标识有实际尺寸',desktop.brandWidth,v=>v>=24);
  check('浅色页面底色为纸色',desktop.bodyBackground,'rgb(248, 249, 247)');

  // 深色：跟随 ?theme=dark 的实际计算样式
  await page.goto(base+'/personal-workstation?theme=dark',{waitUntil:'networkidle0'});
  const dark=await page.evaluate(()=>({
   theme:document.documentElement.dataset.theme,
   bodyBackground:getComputedStyle(document.body).backgroundColor,
   bodyColor:getComputedStyle(document.body).color,
   surfaceBackground:getComputedStyle(document.querySelector('.surface')).backgroundColor,
   surfaceRadius:Math.round(Number.parseFloat(getComputedStyle(document.querySelector('.surface')).borderRadius)),
  }));
  check('深色主题已应用',dark.theme,'dark');
  check('深色页面底色为纸色',dark.bodyBackground,'rgb(25, 28, 32)');
  check('深色正文为亮色',dark.bodyColor,'rgb(238, 241, 245)');
  check('深色容器仍为 12px 圆角',dark.surfaceRadius,12);

  // 移动端：点击目标与焦点环
  await page.setViewport(MOBILE);
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  const mobile=await page.evaluate(()=>{
   const heights=[...document.querySelectorAll('.top .btn,.nav button')].map(node=>Math.round(node.getBoundingClientRect().height));
   return {minHeight:Math.min(...heights),navWidth:Math.round(Number.parseFloat(getComputedStyle(document.querySelector('.nav')).width)),viewport:window.innerWidth};
  });
  check('VI-9 移动端点击目标至少 44px',mobile.minHeight,v=>v>=44);
  check('VI-2 移动端侧栏占满宽度',mobile.navWidth,mobile.viewport);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focus=await page.evaluate(()=>{const node=document.activeElement;return {outline:getComputedStyle(node).outlineWidth,offset:getComputedStyle(node).outlineOffset}});
  check('VI-9 焦点环 3px',focus.outline,'3px');

  // VI-9 正文对比度：**全量**逐文本节点计算，而不是采样几个选择器。
  // 采样会漏掉没有出现在样本里的选择器（历史教训：深色主题缺口因此长期未被发现）。
  const sweepContrast=async()=>page.evaluate(()=>{
   const parse=value=>{const match=/rgba?\(([^)]+)\)/.exec(value);if(!match)return null;const parts=match[1].split(',').map(item=>Number.parseFloat(item));return {r:parts[0],g:parts[1],b:parts[2],a:parts.length>3?parts[3]:1}};
   const linear=channel=>{const c=channel/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4};
   const luminance=color=>0.2126*linear(color.r)+0.7152*linear(color.g)+0.0722*linear(color.b);
   const blend=(top,bottom)=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a),a:1});
   const backgroundOf=node=>{
    let current=node,stack=[];
    while(current){const color=parse(getComputedStyle(current).backgroundColor);if(color&&color.a>0)stack.push(color);current=current.parentElement}
    let result={r:255,g:255,b:255,a:1};
    for(const color of stack.reverse())result=blend(color,result);
    return result;
   };
   const failures=[];
   const root=document.querySelector('.view.active')??document.body;
   for(const node of root.querySelectorAll('*')){
    if(node.children.length||node.closest('[aria-hidden="true"]'))continue;
    const text=(node.textContent||'').trim();
    if(!text)continue;
    const box=node.getBoundingClientRect();
    if(box.width<=0||box.height<=0)continue;
    const style=getComputedStyle(node);
    if(style.visibility==='hidden'||Number(style.opacity)===0)continue;
    const fore=parse(style.color);
    if(!fore)continue;
    const back=backgroundOf(node);
    const mixed=fore.a<1?blend(fore,back):fore;
    const l1=luminance(mixed),l2=luminance(back);
    const ratio=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    const fontSize=Number.parseFloat(style.fontSize),weight=Number(style.fontWeight)||400;
    const large=fontSize>=24||(fontSize>=18.66&&weight>=600);
    const need=large?3:4.5;
    if(ratio<need)failures.push({text:text.slice(0,26),selector:(node.className||node.tagName).toString().slice(0,34),fontSize:Math.round(fontSize),need,ratio:Math.round(ratio*100)/100});
   }
   return failures;
  });
  const views=['home','inbox','space','projects','tasks','knowledge','personal'];
  const sweep=async(theme)=>{
   const failures=[];
   for(const view of views){
    await page.goto(base+'/personal-workstation'+(theme==='dark'?'?theme=dark':''),{waitUntil:'networkidle0'});
    await new Promise(resolve=>setTimeout(resolve,320));
    if(view!=='home'){
     const clicked=await page.evaluate(name=>{const node=document.querySelector('.nav [data-view="'+name+'"]');if(!node)return 'no-control';node.click();return 'clicked'},view);
     if(clicked!=='clicked'){failures.push({view,text:'导航控件不存在，未真正进入该页',selector:'nav',fontSize:0,need:0,ratio:0});continue}
     await new Promise(resolve=>setTimeout(resolve,420));
    }
    // 必须确认真的停在该页，否则扫描就是在空转（历史上吃过这个亏）。
    const active=await page.evaluate(()=>document.querySelector('.view.active')?.id??null);
    if(active!==view){failures.push({view,text:'停在 '+active+' 而不是 '+view,selector:'view.active',fontSize:0,need:0,ratio:0});continue}
    for(const failure of await sweepContrast())failures.push({view,...failure});
   }
   return failures;
  };
  const lightContrast=await sweep('light');
  const darkContrast=await sweep('dark');
  check('VI-9 浅色全量对比度（'+views.length+' 页逐文本节点）',lightContrast.length,0);
  for(const failure of lightContrast)console.log('      · 浅色 '+failure.view+' '+failure.selector+' '+failure.fontSize+'px '+failure.ratio+'<'+failure.need+' '+JSON.stringify(failure.text));
  check('VI-9 深色全量对比度（'+views.length+' 页逐文本节点）',darkContrast.length,0);
  for(const failure of darkContrast)console.log('      · 深色 '+failure.view+' '+failure.selector+' '+failure.fontSize+'px '+failure.ratio+'<'+failure.need+' '+JSON.stringify(failure.text));
  findings.contrast={light:lightContrast,dark:darkContrast};
  // 关键文本的实测值仍单独留档，便于账本引用具体数字。
  await page.goto(base+'/personal-workstation',{waitUntil:'networkidle0'});
  const headline=await page.evaluate(()=>{
   const read=selector=>{const node=document.querySelector(selector);if(!node)return null;const style=getComputedStyle(node);const parse=value=>{const m=/rgba?\(([^)]+)\)/.exec(value);const p=m[1].split(',').map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
    const linear=c=>{const x=c/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4};
    const lum=c=>0.2126*linear(c.r)+0.7152*linear(c.g)+0.0722*linear(c.b);
    let current=node,stack=[];while(current){const c=parse(getComputedStyle(current).backgroundColor);if(c&&c.a>0)stack.push(c);current=current.parentElement}
    let back={r:255,g:255,b:255,a:1};for(const c of stack.reverse())back={r:c.r*c.a+back.r*(1-c.a),g:c.g*c.a+back.g*(1-c.a),b:c.b*c.a+back.b*(1-c.a),a:1};
    const fore=parse(style.color);const l1=lum(fore),l2=lum(back);return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100};
   return {subtitle:read('#subtitle'),metric:read('.metric p'),section:read('.sectionhead small'),resource:read('.resource p')};
  });
  findings.headline=headline;

  findings.pageErrors=pageErrors;
  check('无页面错误',pageErrors.length,0);
 }finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
 }
 findings.passed=findings.failures.length===0;
 return findings;
}

// 工作区路径含非 ASCII：用 pathToFileURL 才能与 import.meta.url 正确比对。
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const findings=await runStyleCheck();
 for(const item of findings.checks)console.log((item.ok?'ok  ':'FAIL')+'  '+item.name+'  → '+JSON.stringify(item.actual));
 console.log(findings.passed?'PASS: VI 几何与配色在真实浏览器中实际生效。':'FAIL: '+findings.failures.join('；'));
 process.exit(findings.passed?0:1);
}
