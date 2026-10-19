#!/usr/bin/env node
/** 交互体检：逐页逐控件点一遍，找出"不符合人的认知"的地方。
 *
 *  起因（用户 2026-10-12）："是不是只是这个连线的功能不太够……其他地方的交互逻辑也不清楚"。
 *  体检项：
 *    ① 死路：点了没有任何反应（没有提示、没有弹窗、界面没变）
 *    ② 多余确认：你自己主动做的事，却要你点"同意"
 *    ③ 机器话：提示/弹窗里出现 JSON 或内部术语
 *    ④ 无去处：列表项既不能点开、也没有就地动作
 *  安全：只在**数据副本**上跑，绝不碰真实库。
 *
 *  用法：node prototype/interaction-audit.mjs [--workspace <id>] [--root <dir>]
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,copyFileSync,existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeExecutable} from '../dev-deps.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const root=join(here,'..');
const argv=process.argv.slice(2);
const argOf=name=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:undefined};
const ROOT=argOf('--root')??'/workspace/飞书工作区';
const WS=argOf('--workspace')??(()=>{
 // 工作区 id 从配置里读；找不到就报错退出（体检必须打真实工作区）
 for(const candidate of ['workspace-id','workspaces.json','config.json']){
  const path=join(ROOT,'workstation-data',candidate);
  if(!existsSync(path))continue;
  const text=readFileSync(path,'utf8');
  // 2026-10-16 修：`workstation-data/workspaces.json` 的真实形状是**一个 id 数组**
  // （一个 UUID 数组，例如 `["00000000-0000-4000-8000-000000000000"]`），原来的两个分支都认不出来 → 这道门禁一直 EXIT=2 跑不动，
  // 而另一道门禁却把它当作"交叉复核"引用（引用了一道根本跑不起来的东西）。
  try{const parsed=JSON.parse(text);if(Array.isArray(parsed)&&typeof parsed[0]==='string')return parsed[0]}
  catch{}
  const match=text.match(/"id"\s*:\s*"([^"]+)"/)??[/^([0-9a-f-]{36})$/.exec(text.trim())];
  if(match)return match[1];
 }
 return undefined;
})();
if(!WS){console.error('找不到工作区 id：请用 --workspace 指定');process.exit(2)}

const {httpRoute}=await import(join(root,'src/http-route.mjs'));
const {WorkstationStore}=await import(join(root,'src/store.mjs'));
const {ExecutionStore}=await import(join(root,'src/execution-store.mjs'));
const {HostFiles}=await import(join(root,'src/host-files.mjs'));
const {createAppleCalendar}=await import(join(root,'src/apple-calendar.mjs'));
const {createFsPort}=await import(join(here,'audit-fs-port.mjs'));

// 数据副本：体检会真的点按钮，不能碰真实库。
const temp=mkdtempSync(join(tmpdir(),'ws-audit-'));
const db=join(temp,'audit.sqlite');
for(const suffix of ['','-wal','-shm']){
 const source=join(ROOT,'workstation-data','workstation.sqlite'+suffix);
 if(existsSync(source))copyFileSync(source,db+suffix);
}
const store=new WorkstationStore(db);
const executions=new ExecutionStore(store);
const grantsPath=join(ROOT,'workstation-data','grants.json');
const files=new HostFiles(createFsPort(),()=>[
 ...(existsSync(grantsPath)?JSON.parse(readFileSync(grantsPath,'utf8')).map(grant=>({...grant,workspace:WS})):[]),
]);
const route=httpRoute({config:{appleCalendar:{enabled:false}},apple:createAppleCalendar(),store,files,executions,
 connection:{admit:()=>({peer:{id:'auditor'}}),requestRejection:()=>undefined},
 workspaceRegistry:{list:()=>[{id:WS,title:'审计工作区',path:ROOT}],get:()=>({id:WS,title:'审计工作区',path:ROOT})},
 allowedWorkspaces:[WS]});
const server=createServer((request,response)=>route.handler(request,response));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/personal-workstation';

const puppeteer=createRequire(join(process.env.HOME,'.dsh/profiles/desktop/node_modules/'))('puppeteer-core');
const browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
await page.setViewport({width:1440,height:1000});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const PAGES=[['总览','overview'],['收件箱','inbox'],['关联空间','space'],['项目','projects'],['任务','tasks'],['知识','knowledge'],['日程与事务','calendar']];
const findings=[];
const push=(item)=>findings.push(item);

const snapshot=()=>page.evaluate(()=>{
 const dialog=document.querySelector('#veil.open,#detailbody');
 const toast=document.querySelector('#toast.show');
 const bar=document.querySelector('#undobar:not([hidden])');
 return {
  dialog:dialog?((document.querySelector('#detailtitle')?.textContent??'')+'|'+(document.querySelector('#detailbody')?.textContent??'').slice(0,400)):null,
  toast:toast?.textContent??null,
  bar:bar?.textContent??null,
  body:(document.querySelector('.view.active')?.innerHTML??'').length,
  url:location.href,
 };
});

await page.goto(base,{waitUntil:'networkidle0'});
await page.waitForFunction(()=>document.querySelector('#projectstrip')!==null,{timeout:20000});

for(const [label,view] of PAGES){
 await page.evaluate(name=>{const button=[...document.querySelectorAll('.nav [data-view]')].find(node=>node.dataset.view===name);button?.click()},view);
 await wait(1200);
 // 页内页签
 const tabs=await page.evaluate(()=>[...document.querySelectorAll('.view.active [role=tab],.view.active .seg button')].map(node=>({text:node.textContent.trim(),selector:node.id?'#'+node.id:null})));
 const panels=[null,...tabs.map(tab=>tab.text)];
 for(const tab of panels){
  if(tab){
   await page.evaluate(text=>{const button=[...document.querySelectorAll('.view.active [role=tab],.view.active .seg button')].find(node=>node.textContent.trim()===text);button?.click()},tab);
   await wait(700);
  }
  const controls=await page.evaluate(()=>[...document.querySelectorAll('.view.active button,.view.active [role=button],.view.active a[href]')]
   .filter(node=>node.offsetParent!==null)
   // 已经在选中状态的控件（当前页签/当前筛选）点了本来就没变化，跳过，避免假报警。
   .filter(node=>!node.classList.contains('active')&&node.getAttribute('aria-selected')!=='true'&&node.getAttribute('aria-current')!=='page')
   .map((node,index)=>({
    index,
    text:(node.textContent??'').trim().slice(0,24),
    id:node.id||null,
    // 稳定定位：id > data-* 的第一个键值 > 文本
    key:node.id?{type:'id',value:node.id}
      :(Object.entries(node.dataset)[0]?{type:'data',value:Object.entries(node.dataset)[0].join('=')}:null),
   })));
  for(const control of controls){
   if(/删除|归档|清空|退出|登录/.test(control.text))continue;   // 破坏性动作单独人工验，不在这里点
   await page.evaluate(()=>{
    window.__mutations=0;
    window.__observer?.disconnect();
    window.__observer=new MutationObserver(records=>{window.__mutations+=records.length});
    window.__observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
   });
   const before=await snapshot();
   let clicked=false;
   try{
    clicked=await page.evaluate(index=>{
     const nodes=[...document.querySelectorAll('.view.active button,.view.active [role=button],.view.active a[href]')].filter(node=>node.offsetParent!==null);
     const node=nodes[index];
     if(!node)return false;
     node.click();
     return true;
    },control.index);
   }catch{clicked=false}
   if(!clicked)continue;
   await wait(650);
   const after=await snapshot();
   // 只算"这次点击新出现"的提示/弹窗：页面里原本就有的文字不能算成这次的结果。
   const freshDialog=after.dialog&&after.dialog!==before.dialog?after.dialog:null;
   const freshToast=after.toast&&after.toast!==before.toast?after.toast:null;
   const freshBar=after.bar&&after.bar!==before.bar?after.bar:null;
   const mutations=await page.evaluate(()=>window.__mutations??0);
   // 变化 = 弹窗/提示/撤销条新出现，或这次点击引起了真实的 DOM 变更（导航、重绘、下载提示都算）。
   const changed=Boolean(freshDialog||freshToast||freshBar)||mutations>0||after.url!==before.url;
   const text=(freshDialog??'')+(freshToast??'');
   if(/\{"|"code"|"message"|批次|草稿|提交|差异|回执|幂等/.test(text))push({level:'red',kind:'机器话',page:label,tab:tab??'默认',control:control.text,detail:text.slice(0,120)});
   if(!changed)push({level:'amber',kind:'点了没反应',page:label,tab:tab??'默认',control:control.text,detail:control.id??(control.key?control.key.type+':'+control.key.value:'')});
   // 关掉可能打开的弹窗，继续下一个
   await page.evaluate(()=>{const close=document.querySelector('#detailclose,#veil.open [data-close],#batchLater');close?.click()});
   await wait(250);
  }
 }

 // 多余确认：自己主动做的事不该弹"同意"
 const drafts=await page.evaluate(async workspace=>{
  const response=await fetch('/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({action:'inbox',status:'draft',workspace})});
  const data=await response.json();
  return (data.items??[]).map(item=>({id:item.id,title:item.title,author:item.source?.author??null}));
 },WS);
 for(const draft of drafts)if(draft.author&&draft.author!=='agent'&&!/Agent|助手/.test(draft.author))push({level:'amber',kind:'多余确认',page:'收件箱',tab:'待确认',control:draft.title,detail:'来源：'+(draft.author??'未知')});
}

await browser.close();server.close();store.close();

const red=findings.filter(item=>item.level==='red');
const amber=findings.filter(item=>item.level==='amber');
const group=list=>{const map=new Map();for(const item of list){const key=item.kind+' · '+item.page+' · '+item.control;if(!map.has(key))map.set(key,item)}return [...map.values()]};
console.log(`交互体检结果：${PAGES.length} 个页面，红色 ${red.length} 项、黄色 ${amber.length} 项`);
for(const item of group(red))console.log(`  [红] ${item.kind} · ${item.page}/${item.tab} · 「${item.control}」 → ${item.detail}`);
for(const item of group(amber))console.log(`  [黄] ${item.kind} · ${item.page}/${item.tab} · 「${item.control}」 → ${item.detail}`);
process.exit(red.length?1:0);
