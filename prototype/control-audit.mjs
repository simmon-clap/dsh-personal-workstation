import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

// 两件审计：① 每个状态的可见控件是否真有处理函数；② 逐个真的点一次，捕获抛错与错误日志。
// 状态包含每个二级标签（知识 5 个、日程 3 个、项目 2 个、任务 2 个），只审默认页会漏掉标签内的控件。
// 使用一次性内存库，点击造成的写入不会影响任何生产数据。
const chrome=chromeExecutable();
const pages=[['home',null],['inbox',null],['space',null],['projects','[data-pmode]'],['tasks','[data-tmode]'],['knowledge','[data-know]'],['personal','[data-personal]']];
const viewports=[{name:'desktop',width:1440,height:940},{name:'mobile',width:390,height:844}];
const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
seedVisualStore(store);
const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'个人空间'}],get:id=>id==='w'?{id:'w'}:null},allowedWorkspaces:['w']});
const server=createServer((request,response)=>route.handler(request,response));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let failures=0
const allNotices=[]
let dialogsOpened=0;
const show=(status,label,detail='')=>console.log(status.padEnd(4)+' '+label.padEnd(28)+detail);
try{
 for(const viewport of viewports){
  const page=await browser.newPage();await page.setViewport({width:viewport.width,height:viewport.height});
  const errors=[];page.on('pageerror',error=>errors.push('pageerror: '+error.message));
  page.on('console',message=>{if(message.type()==='error'&&!/Failed to load resource/.test(message.text()))errors.push('console: '+message.text())});
  page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
  await page.goto('http://127.0.0.1:'+port+'/personal-workstation',{waitUntil:'networkidle0'});
  for(const [name,tabSelector]of pages){
   await page.evaluate(target=>document.querySelector('.nav [data-view="'+target+'"]').click(),name);
   await new Promise(resolve=>setTimeout(resolve,250));
   const tabs=tabSelector?await page.evaluate(selector=>[...document.querySelectorAll(selector)].map(node=>({label:(node.textContent||'').trim(),key:Object.keys(node.dataset)[0],value:Object.values(node.dataset)[0]})),tabSelector):[{label:'默认',key:null,value:null}];
   for(const tab of tabs){
    if(tab.key){await page.evaluate((selector,key,value)=>{const node=[...document.querySelectorAll(selector)].find(candidate=>candidate.dataset[key]===value);if(node)node.click()},tabSelector,tab.key,tab.value);await new Promise(resolve=>setTimeout(resolve,300))}
    const label=viewport.name+' '+name+(tab.key?' · '+tab.label:'');
    const report=await page.evaluate(()=>{
     const visible=element=>{const box=element.getBoundingClientRect();return box.width>0&&box.height>0};
     const delegated=element=>Boolean(element.closest('#knowbody,#personalbody,#detailbody,#home .lower,#spaceSvg,#roadtabs,#tasktabs,#taskfilters,#projecttabs,#personaltabs,#knowtabs,#inboxfilters,#projectsbody,#projectstrip,#roadmap,#tasksbody,#taskmini,#metrics'))||['data-view','data-goto','data-road','data-pmode','data-tmode','data-target','data-know','data-personal','data-kind','data-batch','data-inbox'].some(attribute=>element.hasAttribute(attribute));
     const labelOf=element=>(element.textContent||'').replace(/\s+/g,' ').trim().slice(0,28)||element.getAttribute('aria-label')||element.id;
     const scopes=[document.querySelector('.nav'),document.querySelector('.top'),document.querySelector('.hero'),document.querySelector('.view.active')].filter(Boolean);
     const unhandled=[],controls=[];
     for(const scope of scopes)for(const element of scope.querySelectorAll('button,select,input,a[href]')){
      if(!visible(element)||element.disabled)continue;
      if(!(element.onclick!==null||element.onchange!==null||element.oninput!==null||element.onkeydown!==null||delegated(element)))unhandled.push(labelOf(element));
      // 「去 DSH 对话」按设计会离开工作台去宿主对话（独立页则同源跳 /），不是页内控件：
      // 它由 test/v7-assistant-entry.test.mjs 与安装后的 live-acceptance 覆盖；这里点它会离开页面导致后续页面不存在。
      if(element.id==='assistant')continue;
      if(element.tagName==='BUTTON'||element.tagName==='A'||element.tagName==='SELECT'){element.setAttribute('data-audit',String(controls.length));controls.push(labelOf(element))}
     }
     return {unhandled,controls};
    });
    if(report.unhandled.length){failures+=report.unhandled.length;show('FAIL',label,'无处理函数 '+JSON.stringify(report.unhandled))}
    const before=errors.length;
    const emptyDialogs=[],notices=[];
    for(let index=0;index<report.controls.length;index++){
     const control=report.controls[index];
     await clickWithFrameRetry(page,index);
     await new Promise(resolve=>setTimeout(resolve,110));
     // 弹窗必须真的打开且有内容；异步块（文件状态/收录状态/来源指令）需要更长时间才会落位。
     const opened=await page.evaluate(()=>document.querySelector('#veil')?.classList.contains('open')??false);
     if(opened){
      dialogsOpened+=1;
      await new Promise(resolve=>setTimeout(resolve,340));
      const shape=await page.evaluate(()=>({title:(document.querySelector('#detailtitle')?.textContent||'').trim(),body:(document.querySelector('#detailbody')?.textContent||'').trim().length}));
      if(!shape.title||shape.body===0)emptyDialogs.push(control+' → '+JSON.stringify(shape));
     }
     const toast=await page.evaluate(()=>{const node=document.querySelector('#toast');if(!node||!node.classList.contains('show'))return null;const background=getComputedStyle(node).backgroundColor;return {text:(node.textContent||'').trim().slice(0,60),error:background!=='rgba(0, 0, 0, 0)'&&/140|59|59/.test(background)&&background!=='rgb(36, 50, 75)'}});
     if(toast?.text)notices.push(control+' → '+toast.text);
     await page.keyboard.press('Escape');
     await new Promise(resolve=>setTimeout(resolve,60));
     await page.evaluate(target=>document.querySelector('.nav [data-view="'+target+'"]').click(),name);
     if(tab.key)await page.evaluate((selector,key,value)=>{const node=[...document.querySelectorAll(selector)].find(candidate=>candidate.dataset[key]===value);if(node)node.click()},tabSelector,tab.key,tab.value);
     await new Promise(resolve=>setTimeout(resolve,60));
    }
    const raised=errors.slice(before);
    if(emptyDialogs.length){failures+=emptyDialogs.length;show('FAIL',label,'弹窗打开但内容为空 '+JSON.stringify(emptyDialogs))}
    if(raised.length){failures+=raised.length;show('FAIL',label,'点击报错 '+JSON.stringify(raised))}
    if(!emptyDialogs.length&&!raised.length)show('ok',label,report.controls.length+' 个控件点击无报错'+(notices.length?'，'+notices.length+' 条提示':''));
    allNotices.push(...notices.map(text=>label+' · '+text));
   }
  }
  show(dialogsOpened?'ok':'FAIL','弹窗检查',dialogsOpened+' 个弹窗打开后标题与内容非空');
  if(!dialogsOpened)failures+=1;
  const uniqueNotices=[...new Set(allNotices)];
  if(uniqueNotices.length){
   show('info','界面提示','共 '+allNotices.length+' 条（去重 '+uniqueNotices.length+' 条），供人工核对是否为预期业务提示：');
   for(const text of uniqueNotices.slice(0,12))show('info','  ·',text);
  }
  await page.close();
 }
}finally{await browser.close();server.close();store.close()}
console.log(failures?'发现 '+failures+' 个问题':'全部页面状态两档视口：控件均有处理函数且点击无报错');
process.exitCode=failures?1:0;

/** 点一个控件；只对"页面正在换帧"这一种情况重试。
 *
 *  为什么：点击常常触发整页跳转，puppeteer 在换帧的瞬间求值会抛
 *  `Attempted to use detached Frame`。这是脚手架的时序问题，不是界面缺陷 ——
 *  但**偶发红的门禁比不跑门禁更坏**：人一旦见惯了红，就会开始忽略它。
 *  这里只吞这一种错误并重试，其它错误照旧抛出，不掩盖真问题。 */
async function clickWithFrameRetry(page,position,attempts=3){
 for(let attempt=1;attempt<=attempts;attempt+=1){
  try{
   await page.evaluate(position=>{const element=document.querySelector('[data-audit="'+position+'"]');if(element)element.click()},position);
   return;
  }catch(error){
   const detached=/detached Frame|Execution context was destroyed|Target closed/i.test(error?.message??'');
   if(!detached||attempt===attempts)throw error;
   await new Promise(resolve=>setTimeout(resolve,240));
  }
 }
}

