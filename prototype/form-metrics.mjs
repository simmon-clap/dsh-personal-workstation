import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

/** A3 量化对照（体检报告 A3）：编辑项目表单的**控件总数 / 单行控件数 / 最窄输入框宽度**。
 *
 *  为什么需要它：A3 的问题是"读起来像坏掉的控件"——这类问题必须量出来，不能靠"看起来好多了"。
 *  用真实浏览器 + 与体检报告同一形状的数据（一个带 8 条交付项的项目），改造前后各跑一次即可对照。
 *
 *  阈值（LIMITS）是**改造后**的验收线：单行不超过 3 个控件（交付项第二行是日期+负责人+状态）、
 *  输入框最窄不小于 200px、四个分节齐全、标签里不出现开发式提示。改造前这些都会红。 */

const chrome=chromeExecutable();
export const LIMITS={maxPerRow:3,minFieldInput:400,minItemInput:140,sections:4};
export const devHintPattern=/（YYYY-MM-DD）|（工作区内相对路径|负责人 ID（可留空）|状态：待办\/进行中\/已完成\/受阻/;

export function measure(scope=globalThis.document){
 // 阈值与提示词在函数内再声明一次：puppeteer 会把函数序列化到页面里执行，拿不到模块作用域。
 const document=scope;
 const body=document.querySelector('#detailbody');
 const visible=element=>{const box=element.getBoundingClientRect();return box.width>0&&box.height>0};
 const textLike=element=>element.tagName!=='BUTTON'&&element.type!=='hidden'&&element.type!=='checkbox'&&element.type!=='radio';
 const inActions=element=>Boolean(element.closest('.modalactions'));
 const inItem=element=>Boolean(element.closest('.itemrow'));
 const all=[...body.querySelectorAll('input,select,textarea,button')].filter(element=>element.type!=='hidden'&&!element.hidden&&visible(element));
 const formControls=all.filter(element=>element.tagName!=='BUTTON');
 // 行聚类只算**表单字段区**：底部动作行（生成差异草稿/归档/删除/取消）本来就是一排按钮，不属 A3 的问题。
 const boxes=all.filter(element=>!inActions(element)).map(element=>{
  const box=element.getBoundingClientRect();
  return {element,center:box.top+box.height/2,width:box.width};
 });
 boxes.sort((a,b)=>a.center-b.center);
 const rows=[];
 for(const box of boxes){
  const row=rows.at(-1);
  if(row&&Math.abs(box.center-row.center)<=6){row.items.push(box);row.center=(row.center*(row.items.length-1)+box.center)/row.items.length}
  else rows.push({center:box.center,items:[box]});
 }
 const perRow=rows.map(row=>row.items.length);
 const label=element=>element.dataset.field??element.dataset.role??element.tagName.toLowerCase();
 const widths=list=>list.map(element=>({tag:element.tagName.toLowerCase(),field:label(element),width:Math.round(element.getBoundingClientRect().width)}));
 const full=widths(all.filter(element=>textLike(element)&&!inItem(element)));
 const items=widths(all.filter(element=>textLike(element)&&inItem(element)));
 const hints=[...body.querySelectorAll('label,small,p,span')].map(node=>node.textContent??'').join(' ')
  .match(/（YYYY-MM-DD）|（工作区内相对路径|负责人 ID（可留空）|状态：待办\/进行中\/已完成\/受阻/g)??[];
 return {
  controls:all.length,
  formControls:formControls.length,
  buttons:all.length-formControls.length,
  rows:rows.length,
  maxPerRow:perRow.length?Math.max(...perRow):0,
  perRow,
  worstRow:(rows.find(row=>row.items.length===Math.max(...perRow))?.items??[]).map(item=>label(item.element)),
  // 分两组量宽度：**字段区**的输入必须是全宽（A3 的"183px 像坏掉的控件"就出在这里）；
  // 交付项第二行是 日期+负责人+状态 三件套，按设计就是 160px 上下，另行给下限。
  minFieldInput:full.length?Math.min(...full.map(item=>item.width)):null,
  narrowFields:full.filter(item=>item.width<400).map(item=>item.tag+(item.field?':'+item.field:'')+'='+item.width+'px'),
  minItemInput:items.length?Math.min(...items.map(item=>item.width)):null,
  narrowItems:items.filter(item=>item.width<140).map(item=>item.tag+(item.field?':'+item.field:'')+'='+item.width+'px'),
  sections:body.querySelectorAll('[data-formsection]').length,
  sectionTitles:[...body.querySelectorAll('[data-formsection] > h3')].map(node=>node.textContent),
  devHints:hints,
 };
}

export function problemsOf(metrics){
 const problems=[];
 if(metrics.maxPerRow>LIMITS.maxPerRow)problems.push('单行控件数 '+metrics.maxPerRow+' 超过最多 '+LIMITS.maxPerRow+'（'+metrics.worstRow.join('、')+'）');
 if(metrics.minFieldInput!==null&&metrics.minFieldInput<LIMITS.minFieldInput)problems.push('字段区最窄输入框 '+metrics.minFieldInput+'px 小于 '+LIMITS.minFieldInput+'px：'+metrics.narrowFields.slice(0,4).join('、'));
 if(metrics.minItemInput!==null&&metrics.minItemInput<LIMITS.minItemInput)problems.push('交付项行内最窄输入框 '+metrics.minItemInput+'px 小于 '+LIMITS.minItemInput+'px：'+metrics.narrowItems.slice(0,3).join('、'));
 if(metrics.sections<LIMITS.sections)problems.push('分节数 '+metrics.sections+' 少于 '+LIMITS.sections+'（基本信息 / 归属与负责人 / 计划 / 交付项）');
 if(metrics.devHints.length)problems.push('标签里还有开发式提示：'+[...new Set(metrics.devHints)].join('、'));
 return problems;
}

async function main(){
 const store=new WorkstationStore(':memory:'),executions=new ExecutionStore(store);
 seedVisualStore(store);
 const connection={admit:()=>({peer:{id:'operator'}}),requestRejection:()=>undefined};
 const route=httpRoute({store,executions,connection,workspaceRegistry:{list:()=>[{id:'w',title:'飞书工作区',path:process.cwd()}],get:()=>({id:'w',title:'飞书工作区',path:process.cwd()})},allowedWorkspaces:['w']});
 const server=createServer((request,response)=>route.handler(request,response));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const page=await browser.newPage();await page.setViewport({width:1440,height:1100});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let metrics=null;
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/personal-workstation',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>document.querySelectorAll('#projectstrip [data-project]').length>0,{timeout:15000});
  await page.evaluate(()=>{const card=[...document.querySelectorAll('#projectstrip [data-project]')].find(node=>node.textContent.includes('联合验证'));card.click()});
  await page.waitForFunction(()=>document.querySelector('#detailbody #newprojectedit'),{timeout:10000});
  await page.evaluate(()=>document.querySelector('#newprojectedit').click());
  await page.waitForFunction(()=>document.querySelector('#detailbody [data-field="title"]'),{timeout:10000});
  await new Promise(resolve=>setTimeout(resolve,300));
  metrics=await page.evaluate(measure);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close()}
 console.log(JSON.stringify(metrics,null,1));
 if(!metrics){console.log('FAIL: 没能打开项目编辑表单');process.exit(1)}
 const problems=problemsOf(metrics);
 for(const problem of problems)console.log('FAIL '+problem);
 console.log(problems.length?'发现 '+problems.length+' 个问题：编辑项目表单未达标':'PASS: 编辑项目表单达到量化标准（控件 '+metrics.controls+' 个 · 单行最多 '+metrics.maxPerRow+' 个 · 字段区最窄输入框 '+metrics.minFieldInput+'px · 交付项行内最窄 '+metrics.minItemInput+'px · '+metrics.sections+' 个分节：'+metrics.sectionTitles.join('/')+'）');
 process.exitCode=problems.length?1:0;
}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop()))await main();
