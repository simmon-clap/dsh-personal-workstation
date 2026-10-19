import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** 弹窗审计：把每一个弹窗打开，导出它的**结构序列**（标题行/小节/框/动作行）与**全部按钮文案**。
 *  用途：VI 统一的依据不能靠印象——要把所有弹窗摆在一起看，才能发现"这个弹窗有 3 行按钮、
 *  那个弹窗用 .proof 当说明、另一个用 .notice"这类不一致。 */

const chrome=chromeExecutable();

const OPENERS=[
 {name:'项目详情',view:'projects',selector:'#projectsbody [data-project]'},
 {name:'任务详情',view:'tasks',selector:'#tasksbody [data-task]'},
 {name:'资料详情',view:'knowledge',selector:'#knowbody [data-id]',tab:'files'},
 {name:'议题详情',view:'knowledge',selector:'#knowbody [data-id]',tab:'topics'},
 {name:'记忆引用详情',view:'knowledge',selector:'#knowbody [data-id]',tab:'memory'},
 {name:'日程详情',view:'personal',selector:'#personalbody [data-calevent]',tab:'calendar'},
 {name:'票据（未接入）',view:'personal',selector:'#personalbody [data-id]',tab:'invoice'},
 {name:'行程（未接入）',view:'personal',selector:'#personalbody [data-id]',tab:'travel'},
 {name:'收件箱待确认的改动',view:'inbox',selector:'#inboxbody [data-batch]'},
 {name:'新建菜单',view:'home',selector:'#create'},
 {name:'录入菜单',view:'home',selector:'#create'},
 // 「文件与资料」的顶栏入口在 2026-10-14 由用户拍板删除（与知识页同名页签是同一处内容的两条路径），
 // 内容保留在知识页那个页签 —— 由上面的「资料详情」覆盖，这里不再另开一条。
 {name:'空间与设置',view:'home',selector:'#settings'},
 {name:'AI 如何发现关系',view:'space',selector:'#aiExplain'},
 {name:'关系列表',view:'space',selector:'#allrelations'},
];

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 // 额外造一个待确认草稿，才能看到批次差异弹窗
 const ctx={workspace:'w',actor:'audit',canWrite:true};
 store.draft(ctx,{title:'会前材料归档',changes:[
  {op:'create',id:'a-new',kind:'artifact',data:{title:'会前材料',path:'notes/a.md',fileGrantId:'voice-inbox',fileVersion:'v1',content:'要点'}},
  {op:'update',id:'p-a',expectedRevision:1,data:{title:'联合验证',stage:'方案'}},
 ]});
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 // 依赖只给渲染必需的：多余的半成品桩会让加载中断，页面变空，审计就会得出错误结论。
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区',path:process.cwd()}],get:()=>({id:'w',title:'飞书工作区',path:process.cwd()})},allowedWorkspaces:['w'],
  files:{grants:[{id:'voice-inbox',workspace:'w',root:process.cwd(),read:true,write:false,label:'语音目录（只读）'}]}});
 const server=createServer((q,s)=>route.handler(q,s));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();
 await page.setViewport({width:1440,height:940});
 const pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 const report=[];
 try{
  for(const opener of OPENERS){
   await page.goto('http://127.0.0.1:'+server.address().port+'/personal-workstation',{waitUntil:'networkidle0'});
   // 等真实数据渲染出来再动手：否则只是在空页面上点击，会得出"没实现"的错误结论。
   await page.waitForFunction(()=>document.querySelectorAll('#projectstrip [data-project]').length>0,{timeout:15000});
   await page.evaluate(view=>{const node=document.querySelector('.nav [data-view="'+view+'"]');if(node)node.click()},opener.view);
   await new Promise(resolve=>setTimeout(resolve,500));
   let activeTab=null;
   if(opener.tab){
    await page.evaluate(tab=>{const node=document.querySelector('#knowtabs [data-know="'+tab+'"],#personaltabs [data-personal="'+tab+'"]');if(node)node.click()},opener.tab);
    await new Promise(resolve=>setTimeout(resolve,500));
    // 页签必须真的切过去了：否则点到的是上一个页签的内容，会把审计结论带偏。
    // 2026-10-16 修：原来读的是 `know ?? personal` —— 知识页的页签永远有值，
    // 于是**个人页的每一个弹窗都被判成"页签未切换"而静默跳过**（日程详情从来没被查过）。
    // 现在先看当前在哪个视图，再看对应那一组页签。
    activeTab=await page.evaluate(()=>{
     const view=document.querySelector('.nav [data-view].active')?.dataset.view??null;
     return {view,know:document.querySelector('#knowtabs .active')?.dataset.know??null,personal:document.querySelector('#personaltabs .active')?.dataset.personal??null};
    });
    const current=activeTab.view==='personal'?(activeTab.personal??activeTab.know):(activeTab.know??activeTab.personal);
    if(current!==opener.tab)report.push({name:opener.name,selector:opener.selector,clicked:false,skipped:'页签未切换，实际停在 '+current,open:false,errors:[]});
   }
   // 每个弹窗都从干净状态开始：先确保没有残留弹窗。
   await page.keyboard.press('Escape');
   await new Promise(resolve=>setTimeout(resolve,200));
   if(opener.tab&&activeTab){
    const settled=activeTab.view==='personal'?(activeTab.personal??activeTab.know):(activeTab.know??activeTab.personal);
    if(settled!==opener.tab){await page.keyboard.press('Escape');continue}
   }
   const clicked=await page.evaluate((selector,byText)=>{
    let node=document.querySelector(selector);
    if(!node&&byText)node=[...document.querySelectorAll('button')].find(button=>button.textContent.replace(/\s+/g,'').includes(byText));
    if(!node)return false;node.click();return true;
   },opener.selector,opener.byText??null);
   await new Promise(resolve=>setTimeout(resolve,800));
   const dialog=await page.evaluate(()=>{
    const veil=document.querySelector('#veil');
    if(!veil.classList.contains('open'))return {open:false};
    const body=document.querySelector('#detailbody');
    const shell=document.querySelector('#veil .drawer')||document.querySelector('#veil [role="dialog"]');
    const cs=shell?getComputedStyle(shell):null;
    const h2=shell?.querySelector('h2');
    const blocks=[];
    for(const node of body.children){
     const text=(node.textContent||'').replace(/\s+/g,' ').trim();
     blocks.push({tag:node.tagName.toLowerCase(),cls:String(node.className||''),buttons:[...node.querySelectorAll('button')].map(b=>b.textContent.trim()),text:text.slice(0,60)});
    }
    return {open:true,type:document.querySelector('#detailtype').textContent.trim(),title:document.querySelector('#detailtitle').textContent.trim(),
     blocks,buttons:[...body.querySelectorAll('button')].map(button=>button.textContent.replace(/\s+/g,' ').trim()),
     // 动作区：常规弹窗用 `.modalactions`；设置页按 W1 P0-1 把唯一主色动作放在首屏内容里（`.settingsactions`），
     // 不再用底部粘性动作条（那是 46 号审计点名的「首屏只有底栏按钮」问题的另一半）。两者都算动作区。
     actionRows:body.querySelectorAll('.modalactions,.settingsactions').length,
     noticeCount:body.querySelectorAll('.notice').length,
     proofCount:body.querySelectorAll('.proof').length,
     headingCount:body.querySelectorAll('h3').length,
     inputs:body.querySelectorAll('input,select,textarea').length,
     leakedAppearance:!!body.querySelector('[data-settings-appearance]'),
     style:cs?{blur:cs.backdropFilter,radius:cs.borderRadius,bg:cs.backgroundColor,padding:cs.padding,width:shell.getBoundingClientRect().width,titleSize:h2?getComputedStyle(h2).fontSize:null,titleWeight:h2?getComputedStyle(h2).fontWeight:null}:null};
   });
   report.push({name:opener.name,selector:opener.selector,clicked,errors:[...pageErrors],...dialog});
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
 return report;
}

if(process.argv[1]){
 const report=await main();
 for(const row of report){
  console.log('## '+row.name+(row.open?'':'（未打开：'+(row.clicked?'已点击但弹窗未开':'选择器未命中 '+row.selector)+'）')+(row.errors?.length?' 页面错误 '+row.errors[0].slice(0,80):''));
  if(!row.open)continue;
  console.log('   标题：'+row.type+' / '+row.title);
  console.log('   结构：动作行 '+row.actionRows+' · 说明框 .notice '+row.noticeCount+' · .proof '+row.proofCount+' · 小节 h3 '+row.headingCount+' · 输入 '+row.inputs);
  console.log('   块序列：'+row.blocks.map(block=>block.cls||block.tag).join(' → '));
  console.log('   按钮：'+row.buttons.map(label=>'「'+label+'」').join(' '));
 }
 console.log('\n合计弹窗 '+report.filter(row=>row.open).length+' 个');

 // 规范门禁：标题行只用中文类型、记录名非空、每个弹窗都要有动作区。
 const problems=[];
 for(const row of report){
  if(!row.open)continue;
  if(/\//.test(row.type)||/[A-Za-z]/.test(row.type))problems.push(row.name+'：标题行含英文或斜杠（'+row.type+'）');
  if(!row.title)problems.push(row.name+'：标题为空');
  if(!row.actionRows||row.actionRows<1)problems.push(row.name+'：没有动作区');
  if(row.actionRows>2)problems.push(row.name+'：动作区超过两处（'+row.actionRows+'）');
  const st=row.style||{};
  if(!/blur\(/.test(st.blur||''))problems.push(row.name+'：弹窗外壳没有毛玻璃（backdrop-filter='+st.blur+'）');
  if(parseFloat(st.radius)<16)problems.push(row.name+'：弹窗圆角小于 16px（'+st.radius+'）');
  if(!/\//.test(st.bg||'')||/\/ 1\)/.test(st.bg||''))problems.push(row.name+'：弹窗底色不是半透明（'+st.bg+'）');
  if(parseFloat(st.titleSize)<18)problems.push(row.name+'：弹窗标题小于 18px（'+st.titleSize+'）');
  if(row.name!=='空间与设置'&&row.leakedAppearance)problems.push(row.name+'：外观设置区串进了非设置弹窗');
 }
 const missed=report.filter(row=>!row.open).map(row=>row.name);
 // 2026-10-16 红队实测：正常一次运行就有 4 个弹窗从未打开，而门禁照样 PASS/EXIT=0。
 // "没打开"≠"通过" —— 打不开要么是选择器失效（门禁空转）、要么是真打不开（用户点不开），两种都必须红。
 // 确实不打算覆盖的，写进 ALLOW_MISSING 并说明理由。
 const ALLOW_MISSING=new Set([
  // 未接入的能力没有记录，也就没有"详情弹窗"——页面显示空态而不是弹窗（约束三·未接入不伪造）。
  '票据（未接入）','行程（未接入）',
 ]);
 const uncovered=missed.filter(name=>!ALLOW_MISSING.has(name));
 if(uncovered.length)problems.push('这些弹窗没有打开过，门禁对它们等于没查：'+uncovered.join('、'));
 if(missed.length)console.log('（未覆盖：'+missed.join('、')+'）');
 // 把"为什么没打开"打出来：只看名字无法判断是选择器过期、还是这个弹窗本来就不该有（2026-10-16）。
 for(const row of report.filter(item=>!item.open))console.log('  · '+row.name+' —— '+(row.skipped||('点不到：'+row.selector)));
 if(problems.length){console.log('FAIL: 弹窗规范未达标：');for(const problem of problems)console.log('  · '+problem);process.exit(1)}
 console.log('PASS: 已打开的弹窗标题行只用中文类型、记录名非空、都有动作区；且没有漏开的弹窗。');
}
