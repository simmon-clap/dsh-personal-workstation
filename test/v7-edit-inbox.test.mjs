import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createBatchFlow} from '../prototype/batch.mjs';
import {createEditor} from '../prototype/editor.mjs';
import {settingsHtml,applySettingsStatus} from '../prototype/inbox.mjs';
import {createInbox} from '../prototype/inbox.mjs';

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const seed=store=>{const ctx={workspace:'w',actor:'t',canWrite:true};const draft=store.draft(ctx,{title:'新建项目',changes:[{op:'create',id:'p',kind:'project',data:{title:'项目',tags:['保留'],goal:'目标'}}]});store.commit(ctx,{batchId:draft.id,revision:1,key:'seed'})};

test('editing an existing record keeps fields the form does not expose',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:()=>{}});
 try{
  const {item}=await send('get',{id:'p'});
  await editor.open('project',item);await tick();
  assert.equal(document.querySelector('[data-field="title"]').value,'项目');
  assert.equal(document.querySelector('[data-field="goal"]').value,'目标');
  document.querySelector('[data-field="title"]').value='改名后的项目';
  document.querySelector('#objpreview').click();await tick();await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'编辑项目');
  // 自己填的表单：保存即生效（不再弹确认框）
  const saved=store.get({workspace:'w',actor:'t'},'p');
  assert.equal(saved.data.title,'改名后的项目');
  assert.deepEqual(saved.data.tags,['保留'],'表单未覆盖的字段必须保留');
  assert.equal(saved.data.goal,'目标');
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
test('inbox separates clean drafts from conflicting ones per PRD v1.3 CH-04',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:()=>{}});
 const root=document.querySelector('#knowbody');
 try{
  const ctx={workspace:'w',actor:'t',canWrite:true};const seed=store.draft(ctx,{title:'种子',changes:[{op:'create',id:'t1',kind:'task',data:{title:'任务'}}]});store.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  await send('draft',{title:'干净的改动',changes:[{op:'create',id:'n1',kind:'topic',data:{title:'新议题'}}]});
  await send('draft',{title:'过期的改动',changes:[{op:'update',id:'t1',expectedRevision:99,data:{title:'过期修改'}}]});
  await inbox.render(root,'pending');
  assert.match(root.textContent,/干净的改动/);assert.doesNotMatch(root.textContent,/过期的改动/,'待确认不应包含冲突的改动');
  await inbox.render(root,'blocked');
  assert.match(root.textContent,/过期的改动/);assert.match(root.textContent,/需补充\/冲突/);assert.doesNotMatch(root.textContent,/干净的改动/);
  await inbox.render(root,'done');
  assert.match(root.textContent,/种子/);assert.doesNotMatch(root.textContent,/干净的改动/);
  await inbox.render(root,'cancelled');
  assert.match(root.textContent,/暂时没有新的改动/);
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});

test('inbox facets filter the loaded batches by project, kind and source',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:()=>{},projects:[{id:'p1',title:'项目一'},{id:'p2',title:'项目二'}]});
 const root=document.querySelector('#knowbody');
 try{
  const ctx={workspace:'w',actor:'t',canWrite:true};const seed=store.draft(ctx,{title:'种子',changes:[{op:'create',id:'p1',kind:'project',data:{title:'项目一'}},{op:'create',id:'p2',kind:'project',data:{title:'项目二'}}]});store.commit(ctx,{batchId:seed.id,revision:1,key:'seed'});
  await send('draft',{title:'项目一的资料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'资料一',projectId:'p1'}}]});
  await send('draft',{title:'项目二的任务',changes:[{op:'create',id:'t9',kind:'task',data:{title:'任务九',projectId:'p2'}}]});
  await inbox.render(root,'');
  assert.match(root.textContent,/项目一的资料/);assert.match(root.textContent,/项目二的任务/);
  const facet=(name,value)=>{const select=root.querySelector('[data-facet="'+name+'"]');select.value=value;select.onchange()};
  facet('project','p1');await tick();
  assert.match(root.textContent,/项目一的资料/);assert.doesNotMatch(root.textContent,/项目二的任务/,'按项目筛选应排除其他项目的待确认的改动');
  facet('project','');await tick();
  facet('kind','update');await tick();
  assert.match(root.textContent,/暂时没有新的改动/,'按变更类型筛选应排除不含该操作的改动');
  facet('kind','create');await tick();
  assert.match(root.textContent,/项目一的资料/);
  facet('source','来源：撤销记录编号');await tick();
  assert.match(root.textContent,/暂时没有新的改动/,'按来源筛选应排除其他来源的待确认的改动');
  facet('source','来源：工作台录入');await tick();
  assert.match(root.textContent,/项目二的资料|项目一的资料/);
  assert.match(root.textContent,/只影响当前列表/,'筛选范围必须如实说明（用用户能懂的话）');
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});

test('editor archives an existing record through a previewed batch',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:()=>{}});
 try{
  const {item}=await send('get',{id:'p'});
  await editor.open('project',item);await tick();
  document.querySelector('#objarchive').click();await tick();await tick();
  assert.match(document.querySelector('#detailbody').textContent,/归档/);
  document.querySelector('#batchCommit').click();for(let i=0;i<3;i++)await tick();
  assert.equal(store.get({workspace:'w',actor:'t'},'p').archived,true);
  assert.equal(store.list({workspace:'w',actor:'t'}).length,0,'归档对象不再出现在活跃列表');
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});
test('shared inbox reviews drafts and offers receipt-based undo for committed batches',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:(text,error)=>notes.push([text,error]),openStatus:()=>{}});
 try{
  await send('draft',{title:'对话创建的任务',changes:[{op:'create',id:'t1',kind:'task',data:{title:'来自对话'}}]});
  const root=document.querySelector('#knowbody');
  await inbox.render(root);
  assert.match(root.textContent,/对话创建的任务/,'收件箱应作为知识页二级视图渲染改动列表');
  assert.match(root.textContent,/待确认/);
 // 卡片改版后：操作计数按类型分开渲染（图标＋数字＋标签），并有状态点与差异条。
  const chip=root.querySelector('[data-opcount="create"]');
  assert(chip,'待确认的改动卡片必须显示按类型统计的操作计数');
  assert.match(chip.textContent,/1 新建/);
  assert(root.querySelector('.statusdot[data-state="draft"]'),'待确认待确认的改动要有状态点（可视化，而不是只有文字）');
  assert(root.querySelector('.diffbar i'),'待确认的改动卡片要有改动条');
  root.querySelector('[data-batch]').click();for(let i=0;i<3;i++)await tick();
  assert.equal(document.querySelector('#detailtitle').textContent,'对话创建的任务','待确认的改动应打开确认预览');
  document.querySelector('#batchCommit').click();for(let i=0;i<3;i++)await tick();
  await inbox.render(root,'done');
  assert.match(root.textContent,/已处理/);
  assert.match(root.textContent,/这次要做/,'待确认的改动卡片应显示条目数');
  root.querySelector('[data-batch]').click();for(let i=0;i<3;i++)await tick();
  assert.match(document.querySelector('#detailbody').textContent,/记录编号/);
  document.querySelector('#inboxundo').click();for(let i=0;i<4;i++)await tick();
  assert.match(document.querySelector('#detailtitle').textContent,/^撤销这次改动/, '撤销应生成可预览的撤销待确认的改动');
  assert.equal(store.get({workspace:'w',actor:'t'},'t1').archived,false,'撤销提交前不得改动对象');
  document.querySelector('#batchCommit').click();for(let i=0;i<4;i++)await tick();
  assert.equal(store.get({workspace:'w',actor:'t'},'t1').archived,true,'撤销提交后应恢复原始状态');
  assert.deepEqual(notes,[]);
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});

test('settings first screen = authorization + assistant status + one action；其余进折叠',async()=>{
 const dom=shell(),document=dom.window.document;
 const status={package:'dsh-personal-workstation',version:'2.6.0',workspace:{id:'w',title:'飞书工作区'},writeRequiresApproval:true,build:{builtAt:'2026-10-17T10:00:00.000Z',needsRestart:true},
  capabilities:{textFiles:{readGrants:2,writeGrants:1},knowledge:{baseGrants:1,mode:'lexical'},execution:false,officePreview:true,speechToText:true,speech:{available:true,providers:[{id:'sensevoice',name:'SenseVoiceSmall (INT8)',phase:'standby'}],selection:{providerId:'sensevoice',language:'auto'}},calendarSync:false,deviceSync:false,integrations:{feishu:{configured:false,connected:false,reason:'未配置（在 DSH 的插件设置里填）'},mini:{configured:false,connected:false,reason:'未配置（在 DSH 的插件设置里填）'}}}};
 const timing={status:{scheduled:true,intervalMinutes:60,lastSuccessAt:'2026-10-17T13:54:51.288Z',totalRuns:14,silentHours:0.6,alert:null}};
 const send=async action=>{if(action==='runtime_status')return status;if(action==='heartbeat_status')return timing;if(action==='speak_status')throw Error('未接入');throw Error(action)};
 const inbox=createInbox(document,send,{draft:async()=>({}),open:()=>{},notify:()=>{}});
 const settle=async(times=24)=>{for(let index=0;index<times;index+=1)await new Promise(resolve=>setImmediate(resolve))};
 try{
  await inbox.openSettings();await settle();
  const body=document.querySelector('#detailbody');
  assert(body.querySelector('[data-settings-firstscreen]'),'首屏容器必须存在');
  assert(body.querySelector('[data-settings-manage="grants"]'),'首屏必须有授权管理动作');
  assert(body.querySelector('#settingsheartbeat')?.dataset.settingsPrimary==='heartbeat','首屏必须有唯一主色动作');
  // 定时：唯一事实源 + 唯一话术
  const timer=body.querySelector('[data-settings-row="timing"]');
  assert.match(timer.textContent,/已开启 · 每 60 分钟自己醒一次/,'定时必须说清间隔');
  assert.equal(timer.dataset.timerState,'ok');
  assert.doesNotMatch(body.textContent,/还没有接入定时|已在定时运行/,'三套旧说法必须删干净');
  // 授权与能力
  assert.match(body.querySelector('[data-settings-cell="folders"]').textContent,/2 个（可读写 1 · 只读 1）/);
  assert.match(body.querySelector('[data-settings-cell="knowledge"]').textContent,/已接上 1 个/);
  const caps=body.querySelector('[data-settings-cell="caps"]').textContent;
  assert.match(caps,/读文件/);
  assert.doesNotMatch(caps,/未接上/,'"已接上"一行只列接上的能力');
  assert(body.querySelector('[data-settings-off="1"]'),'没接上的能力必须收进折叠');
  // 信息搬家：版本/留痕/帮助都不在首屏容器里
  const first=body.querySelector('[data-settings-firstscreen]').textContent;
  assert.doesNotMatch(first,/版本与设计|纸上秩序/,'版本/设计基线不得占首屏');
  assert(body.querySelector('[data-settings-details="history"]'));
  assert(body.querySelector('[data-settings-details="about"]'));
  assert(body.querySelector('[data-settings-details="help"]'));
  assert.match(body.textContent,/飞书 \/ Slack 里的助理/,'要追细节里的说明仍在（只是收进折叠）');
  assert.match(body.textContent,/来自 IM 会话的写入会进同一个收件箱/);
 }finally{inbox.dispose();dom.window.close()}
});

test('settings refuses to imply capabilities when the runtime status is unavailable',async()=>{
 const dom=shell(),document=dom.window.document;
 const send=async action=>{if(action==='runtime_status')throw Error('无法连接工作台服务');if(action==='heartbeat_status')throw Error('无法连接工作台服务');throw Error(action)};
 const inbox=createInbox(document,send,{draft:async()=>({}),open:()=>{},notify:()=>{}});
 const settle=async(times=20)=>{for(let index=0;index<times;index+=1)await new Promise(resolve=>setImmediate(resolve))};
 try{
  await inbox.openSettings();await settle();
  const body=document.querySelector('#detailbody');
  assert.match(body.querySelector('[data-settings-cell="folders"]').textContent,/读不到/,'状态读不到时必须写读不到');
  assert.match(body.querySelector('[data-settings-cell="timing"]').textContent,/读不到定时状态/);
  assert(body.querySelector('[data-settings-retry="status"]'),'失败态必须有一个重试下一步');
  assert(body.querySelector('[data-settings-retry="timing"]'));
  assert.doesNotMatch(body.textContent,/已接上宿主/);
 }finally{inbox.dispose();dom.window.close()}
});

test('speech capability distinguishes an absent service, a missing model and a ready model',async()=>{
 const {speechLine}=await import('../prototype/inbox.mjs');
 assert.match(speechLine({speechToText:false}),/未接入/);
 assert.match(speechLine({speechToText:true,speech:{providers:[]}}),/没有登记任何识别提供方/,'服务在但没有提供方也要如实说');
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'s',name:'SenseVoice',phase:'ready'}]}}),/本地模型已就绪/);
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'s',name:'SenseVoice',phase:'standby'}]}}),/本地模型未准备（首次使用会下载，约 1GB）/);
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'s',name:'SenseVoice',phase:'preparing'}]}}),/本地模型下载中/);
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'s',name:'SenseVoice',phase:'failed'}]}}),/本地模型准备失败/);
 assert.match(speechLine({speechToText:true,speech:{providers:[{id:'s',name:'X',phase:'weird'}]}}),/状态 weird/,'未知状态照实显示，不美化');
});

test('grants cells tell the user what to configure when nothing is authorised',async()=>{
 const document=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8')).window.document;
 const root=document.createElement('div');document.body.append(root);root.innerHTML=settingsHtml();
 applySettingsStatus(root,{package:'dsh-personal-workstation',version:'2.6.0',capabilities:{textFiles:{readGrants:0,writeGrants:0},knowledge:{baseGrants:0},execution:false,officePreview:true,speechToText:true,calendarSync:false,integrations:{}}});
 const text=root.textContent;
 assert.match(root.querySelector('[data-settings-cell="folders"]').textContent,/还没有/,'没有授权时必须说还没有，而不是只显示 0');
 assert.match(root.querySelector('[data-settings-knowledge-note]').textContent,/在 DSH 设置里给工作台加知识库/,'下一步必须写清楚');
 assert.match(text,/读文件[\s\S]{0,80}还没有给工作台任何文件夹/,'没接上的项要有原因');
 assert.doesNotMatch(text,/cordis\.patch\.yml|profile/,'不许把配置文件端给用户');
});

test('grants cells stay quiet when folders and knowledge already exist',async()=>{
 const document=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8')).window.document;
 const root=document.createElement('div');document.body.append(root);root.innerHTML=settingsHtml();
 applySettingsStatus(root,{capabilities:{textFiles:{readGrants:2,writeGrants:1},knowledge:{baseGrants:1},execution:true,officePreview:false,speechToText:false,calendarSync:false,integrations:{}}});
 assert.match(root.querySelector('[data-settings-cell="folders"]').textContent,/2 个（可读写 1 · 只读 1）/);
 assert.match(root.querySelector('[data-settings-cell="knowledge"]').textContent,/已接上 1 个/);
 assert.doesNotMatch(root.textContent,/还没有给工作台任何文件夹/,'已有授权时不得再提示未授权');
});

test('a batch shows the instruction that produced it, and says so when it cannot',async()=>{
 const dom=shell(),document=dom.window.document;
 const batch={id:'b1',title:'来自会话的待确认的改动',revision:1,status:'draft',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}],diff:[{op:'create',id:'p',before:null,after:{title:'P'}}]};
 const calls=[];
 const send=async(action,data)=>{calls.push({action,data});
  if(action==='preview')return batch;
  if(action==='batch_origin')return {available:true,sessionId:'session-1',title:'飞书 · 会议整理',count:9,messages:[{seq:8,text:'把会议纪要整理成项目'},{seq:9,text:'负责人写我'}],truncated:true};
  throw Error(action)};
 const flow=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  await flow.open('b1');await tick();await tick();
  const origin=document.querySelector('#detailbody [data-origin]');
  assert(origin,'待确认的改动必须显示来源指令');
  assert.match(origin.textContent,/飞书 · 会议整理/);
  assert.match(origin.textContent,/共 9 条指令，显示最近 2 条/);
  assert.match(origin.textContent,/把会议纪要整理成项目/);
  assert.match(origin.textContent,/负责人写我/);
  assert.deepEqual(calls.find(call=>call.action==='batch_origin').data,{id:'b1'},'只按待确认的改动 id 查询，不接受模型提供的会话');
 }finally{flow.dispose();dom.window.close()}
});
test('a batch with no readable origin says so instead of showing an empty block',async()=>{
 const dom=shell(),document=dom.window.document;
 const batch={id:'b2',title:'手工待确认的改动',revision:1,status:'draft',changes:[{op:'create',id:'p',kind:'project',data:{title:'P'}}],diff:[{op:'create',id:'p',before:null,after:{title:'P'}}]};
 const send=async action=>{if(action==='preview')return batch;if(action==='batch_origin')return {available:false,reason:'此待确认的改动没有记录来源会话（人工录入）',messages:[]};throw Error(action)};
 const flow=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  await flow.open('b2');await tick();await tick();
  const origin=document.querySelector('#detailbody [data-origin]');
  assert(origin);
  assert.match(origin.textContent,/人工录入/,'读不到原文时必须说明原因');
 }finally{flow.dispose();dom.window.close()}
});

test('about and capability facts stay honest（版本/数据根/写入审批/设计基线/转写）',async()=>{
 const {aboutHtml,capabilityFacts}=await import('../prototype/inbox.mjs');
 const html=aboutHtml({package:'dsh-personal-workstation',version:'2.6.0',build:{builtAt:'2026-10-17T10:00:00.000Z',needsRestart:true},
  capabilities:{textFiles:{readGrants:1,writeGrants:0,labels:['语音目录（只读）']},knowledge:{baseGrants:0},officePreview:true,speechToText:true,speechApprovalRequired:false,speech:{providers:[{id:'p',name:'本地模型',phase:'standby'}]},execution:false,calendarSync:false,integrations:{}}});
 assert.match(html,/dsh-personal-workstation 2\.6\.0/,'关于里必须有版本');
 assert.match(html,/重启 DSH 之后生效/,'是否要重启必须写明');
 assert.match(html,/数据放在哪/);
 assert.match(html,/AI 提的改动、画布位置：要你点同意才生效/,'写入审批要说人话');
 assert.match(html,/外观/,'关于里保留用户用得上的外观说明');
 assert.match(html,/浅色与深色用同一套颜色和字号/);
 assert.doesNotMatch(html,/design-system|tokens\.css|PRD v1\.0/,'关于里不能再出现设计/实现说明');
 assert.match(html,/在浏览器中登录 DSH/);
 const facts=capabilityFacts({textFiles:{readGrants:1,writeGrants:0},knowledge:{baseGrants:0},officePreview:true,speechToText:true,speech:{providers:[{id:'p',name:'本地模型',phase:'standby'}]},execution:false,calendarSync:false});
 const speech=facts.find(item=>item.name==='录音转写');
 assert.match(speech.text,/本地模型未准备（首次使用会下载，约 1GB）/,'必须区分服务已加载与模型未准备');
 assert.match(facts.find(item=>item.name==='读文件').text,/可读 1 个文件夹/);
 assert.match(facts.find(item=>item.name==='查知识库').next,/加知识库/);
 assert.doesNotMatch(JSON.stringify(facts),/录音转写服务.*未接入/,'录音转写已经实现，不能再写成未接入');
});

test('settings let the user browse, create and authorise folders in two steps',async()=>{
 const dom=shell(),document=dom.window.document;
 const calls=[];
 const send=async(action,data)=>{calls.push({action,data});
  if(action==='runtime_status')return {version:'2.6.0',workspace:{id:'w',title:'飞书工作区'},capabilities:{textFiles:{readGrants:0,writeGrants:0,labels:[]},knowledge:{baseGrants:0},speechToText:true,integrations:{}}};
  if(action==='heartbeat_status')return {status:{scheduled:false,intervalMinutes:0,lastSuccessAt:null,totalRuns:0}};
  if(action==='inbox')return {items:[]};
  if(action==='directory_list')return {path:data?.path??'',parent:'',items:[{name:'资料',path:'资料'},{name:'会议',path:'会议'}],authorized:[]};
  if(action==='directory_create')return {name:data.name,path:data.name};
  if(action==='grant_add')return {grant:{id:'dir-1',label:data.label,read:true,write:data.write===true}};
  throw Error(action)};
 const inbox=createInbox(document,send,{draft:async()=>({}),open:()=>{},notify:()=>{}});
 const settle=async(times=30)=>{for(let index=0;index<times;index+=1)await new Promise(resolve=>setImmediate(resolve))};
 try{
  await inbox.openSettings();await settle();
  const body=document.querySelector('#detailbody');
  // 授权面板默认收起（首屏不为它付高度），点「管理」展开
  assert(body.querySelector('#grantsbody').hidden,'授权面板首屏必须收起');
  body.querySelector('[data-settings-manage="grants"]').click();await settle();
  assert(!body.querySelector('#grantsbody').hidden,'点管理必须展开授权面板');
  body.querySelector('[data-grant-add]').click();await settle();
  assert.equal(body.querySelectorAll('[data-grant-read],[data-grant-write]').length,0,'浏览状态下不得出现授权按钮（权限只在第二步）');
  const enter=body.querySelector('[data-folder-enter="资料"]');assert(enter,'必须能进入文件夹');
  enter.click();await settle();
  const select=body.querySelector('[data-folder-select]');assert(select,'必须能选中当前文件夹');
  select.click();await settle();
  assert.equal(body.querySelectorAll('[data-grant-step="2"]').length,1,'选完目录必须进入确认权限这一步');
  const permissions=[...body.querySelectorAll('[data-grant-permission]')];
  assert.equal(permissions.length,2,'权限只能是只读/可读写两种');
  permissions.find(node=>node.dataset.grantPermission==='read').click();await settle();
  const grant=calls.find(call=>call.action==='grant_add');
  assert(grant,'点权限必须真的调用授权动作');
  assert.deepEqual({path:grant.data.path,read:grant.data.read,write:grant.data.write},{path:'资料',read:true,write:false});
  // 新建文件夹
  body.querySelector('[data-grant-add]').click();await settle();
  const input=body.querySelector('[data-folder-newname]');input.value='会议录音';
  body.querySelector('[data-folder-create]').click();await settle();
  const created=calls.find(call=>call.action==='directory_create');
  assert(created&&created.data.name==='会议录音','必须能在界面里新建文件夹');
  assert.match(body.textContent,/授权立即生效，不用重启/,'必须说明生效方式');
 }finally{inbox.dispose();dom.window.close()}
});

test('fixed grants show their real permission and cannot be revoked from the interface',async()=>{
 const dom=shell(),document=dom.window.document;
 const send=async(action,data)=>{
  if(action==='runtime_status')return {version:'2.6.0',workspace:{id:'w',title:'飞书工作区'},capabilities:{textFiles:{readGrants:2,writeGrants:1,labels:['工作台根目录（可读写）','语音目录（只读）']},knowledge:{baseGrants:1},speechToText:true,integrations:{}}};
  if(action==='heartbeat_status')return {status:{scheduled:false,intervalMinutes:0,lastSuccessAt:null,totalRuns:0}};
  if(action==='inbox')return {items:[]};
  if(action==='directory_list')return {path:'',parent:'',items:[],authorized:[
   {id:'cfg-root',root:'/root',label:'工作台根目录',read:true,write:true},
   {id:'cfg-voice',root:'/voice',label:'语音目录',read:true,write:false},
   {id:'dir-meeting',root:'/meeting',label:'会议',read:true,write:true}]};
  throw Error(action)};
 const inbox=createInbox(document,send,{draft:async()=>({}),open:()=>{},notify:()=>{}});
 const settle=async(times=30)=>{for(let index=0;index<times;index+=1)await new Promise(resolve=>setImmediate(resolve))};
 try{
  await inbox.openSettings();await settle();
  const body=document.querySelector('#detailbody');
  body.querySelector('[data-settings-manage="grants"]').click();await settle();
  assert.match(body.textContent,/由 DSH 设置固定 · 界面不能改/,'配置固定的授权必须写明来源和不可改');
  assert.match(body.textContent,/工作台根目录[\s\S]{0,30}可读写/,'固定的可读写授权不得写成只读');
  assert.equal(body.querySelector('[data-revoke="cfg-root"]'),null,'配置固定项不得有取消按钮');
  assert(body.querySelector('[data-revoke="dir-meeting"]'),'界面授权必须能取消');
 }finally{inbox.dispose();dom.window.close()}
});

test('inbox approve really commits the batch, clears the card and offers undo',async()=>{
 const store=new WorkstationStore(':memory:');
 const send=bridge(store);
 await send('draft',{title:'会前材料归档',changes:[{op:'create',id:'art-x',kind:'artifact',data:{title:'会前材料',path:'a.md',content:'要点'}}]});
 const {items}=await send('inbox',{status:'draft'});
 assert.equal(items.length,1,'前置条件：待确认里应该有一条');

 const dom=shell();const {document}=dom.window;
 const committed=[];   // 回执：以前永远是空的，因为回调根本没接上
 const inbox=createInbox(document,send,createBatchFlow(document,send),{
  notify:()=>{},
  onCommitted:receipt=>committed.push(receipt),
 });
 await inbox.render(document.querySelector('#knowbody'),'pending');
 await tick();
 const approve=document.querySelector('[data-inboxapprove]');
 assert.ok(approve,'待确认的批次卡上必须有「同意」');
 approve.click();
 for(let i=0;i<40&&committed.length===0;i++)await tick();

 // ① 没有抛技术错误（以前这里会 ReferenceError，被 catch 成一句技术提示）
 const toast=(document.querySelector('#toast')?.textContent??'');
 assert.ok(!/is not defined|ReferenceError/.test(toast),'不能把内部错误当提示给用户：'+toast);
 // ② 批次真的提交了
 const after=await send('inbox',{status:'draft'});
 assert.equal(after.items.length,0,'同意之后这条不该再留在待确认里');
 const live=await send('list',{kind:'artifact',limit:50});
 assert.ok(live.items.some(x=>x.id==='art-x'),'同意之后对象必须真的写进工作台');
 // ③ 回调拿到了回执（撤销条就是靠它）
 assert.equal(committed.length,1,'同意后必须把回执交出来（否则没有「已保存 · 撤销」）');
 dom.window.close();
});

// ── W1 P0-5：IM 助理·飞书 四层健康面（T5-1…T5-5）──────────────────────────────
// 46 号审计：飞书坏在四层叠加，设置页却只写「未配置」，用户无法行动。
import {imHealthHtml} from '../prototype/inbox.mjs';
import {IM_HEALTH_PATTERNS} from '../prototype/semantic-checks.mjs';

const imFixture = () => ({
  readAt: '2026-10-17T15:00:00.000Z',
  plugin: {state: 'incompatible', name: '@michengai/dsh-im-connect', version: '0.1.68', runtimeVersion: '0.2.1-rc.2', requirementsSummary: '6 个宿主包要求 <=0.2.0-rc.2'},
  channel: {state: 'last-failure', id: 'feishu_x', title: '飞书账号', enabled: true, receiveEnabled: true, lastError: '连接失败，请查看本机日志', recordAt: '2026-10-17T00:00:00.000Z',
    log: {at: '2026-10-16T23:59:29.660Z', code: '21001', summary: '飞书拒绝签发 token（21001 访问控制）'}},
  cwd: {state: 'wrong', value: '~/.dsh/profiles/desktop', expectedTitle: '飞书工作区', expected: '~/Desktop/DSH/飞书工作区'},
  send: {implemented: false, note: '工作台没有往飞书发消息的代码'}
});

test('T5-1：四层健康命中 S10 的四条文案判据（单一来源）', () => {
  const text = new JSDOM(`<body>${imHealthHtml(imFixture())}</body>`).window.document.body.textContent;
  for (const [name, pattern] of Object.entries(IM_HEALTH_PATTERNS)) {
    assert.match(text, pattern, 'S10 判据「' + name + '」不成立：' + text.slice(0, 160));
  }
});

test('T5-2：拆成两行——IM 助理·飞书（四层）与工作台直连飞书（未实现发送）', () => {
  const dom = new JSDOM(`<body>${imHealthHtml(imFixture())}</body>`);
  const text = dom.window.document.body.textContent;
  assert.match(text, /IM 助理 · 飞书/);
  assert.match(text, /工作台直连飞书/);
  assert.match(text, /未实现发送/);
  assert.equal(dom.window.document.querySelectorAll('[data-imlayer]').length, 4, '四层缺一不可');
  assert(dom.window.document.querySelector('[data-directfeishu]'));
});

test('T5-3：状态到 DOM 一一映射（L0 不兼容 / L1 上次失败 / L2 指错目录 / L3 未实现）', () => {
  const doc = new JSDOM(`<body>${imHealthHtml(imFixture())}</body>`).window.document;
  assert.equal(doc.querySelector('[data-imlayer="L0"]').dataset.state, 'off');
  assert.match(doc.querySelector('[data-imlayer="L0"]').textContent, /不兼容/);
  assert.match(doc.querySelector('[data-imlayer="L1"]').textContent, /21001/);
  assert.equal(doc.querySelector('[data-imlayer="L2"]').dataset.state, 'off');
  assert.match(doc.querySelector('[data-imlayer="L2"]').textContent, /飞书工作区/);
  assert.match(doc.querySelector('[data-imlayer="L3"]').textContent, /未实现/);
  assert.match(doc.querySelector('[data-imsummary]').textContent, /插件加载/,'汇总必须指出第一个坏的层');
});

test('T5-4：读不到 IM 状态 → 四层都写读不到，不得写「未加载/未配置」', () => {
  const dom = new JSDOM(`<body>${imHealthHtml(undefined)}</body>`), doc = dom.window.document;
  const rows = [...doc.querySelectorAll('[data-imlayer]')];
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.dataset.state, 'unknown');
  assert.match(doc.body.textContent, /读不到/);
  // 解释里可以说"这不等于未加载或未配置"，但**值**不得写成未加载/未配置（那才是推断）。
  for (const row of rows) assert.doesNotMatch(row.querySelector('b').textContent, /未加载|未配置/);
});

test('T5-5：界面不出现凭据，也不出现 home 绝对路径', () => {
  const text = imHealthHtml(imFixture());
  for (const secret of ['appSecret', 'appId', 'ownerOpenId', 'SECRET-DO-NOT-LEAK', 'cli_', 'ou_', '/Users/example']) assert(!text.includes(secret), '泄漏了：' + secret);
});

test('unsaved edits: Escape pauses with a visible choice instead of discarding silently',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);seed(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const editor=createEditor(document,send,batch,{notify:()=>{}});
 const escape=()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 try{
  const {item}=await send('get',{id:'p'});
  await editor.open('project',item);await tick();
  const field=document.querySelector('[data-field="title"]');
  field.value='改了一半';field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  escape();await tick();
  assert.equal(document.querySelector('#veil').classList.contains('open'),true,'有未保存内容时第一次 Esc 不能直接关');
  const bar=document.querySelector('[data-unsaved="1"]');
  assert.ok(bar,'必须出现「继续编辑 / 放弃修改」的提示');
  assert.ok(bar.querySelector('[data-unsaved-keep]'),'要有继续编辑');
  assert.ok(bar.querySelector('[data-unsaved-drop]'),'要有放弃修改');
  bar.querySelector('[data-unsaved-keep]').click();await tick();
  assert.equal(document.querySelector('[data-unsaved="1"]'),null,'继续编辑后提示收起');
  escape();await tick();
  assert.equal(document.querySelector('#veil').classList.contains('open'),true,'提示收起后再次 Esc 仍然先停一次');
  document.querySelector('[data-unsaved-drop]').click();await tick();
  assert.equal(document.querySelector('#veil').classList.contains('open'),false,'点「放弃修改」才关闭');
 }finally{editor.dispose();batch.dispose();store.close();dom.window.close()}
});

test('pending checks appear in the inbox and open the judgment they came from',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const c={workspace:'w',actor:'t',canWrite:true};
 const seedJudgment=store.draft(c,{title:'判断',changes:[{op:'create',id:'j1',kind:'judgment',data:{title:'合作结构模式有风险',status:'checking',validFrom:'2026-09-01',uncertainty:'尚未核对对方已有的案例记录',evidence:[{kind:'file',ref:'纪要.md#3',quote:'示例依据：合作结构需要分阶段验证'}]}}]});
 store.commit(c,{batchId:seedJudgment.id,revision:1,key:'j1'});
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:()=>{}});
 const opened=[];
 inbox.setOpenRecord(id=>opened.push(id));
 const root=document.querySelector('#knowbody');
 try{
  await inbox.render(root);
  const section=root.querySelector('[data-pending-checks="1"]');
  assert.ok(section,'待核对必须进收件箱');
  assert.match(section.textContent,/问什么/);
  assert.match(section.textContent,/算完成/);
  assert.match(section.textContent,/尚未核对对方已有的案例记录/);
  const card=section.querySelector('[data-check]');
  assert.equal(card.getAttribute('role'),'button','整张卡可点，数字/状态才点得回原因');
  card.click();
  assert.deepEqual(opened,['j1'],'点按钮要打开那条判断');
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});

test('no pending checks means the inbox shows no empty follow-up block',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:()=>{}});
 const root=document.querySelector('#knowbody');
 try{
  await inbox.render(root);
  assert.equal(root.querySelector('[data-pending-checks="1"]'),null,'没有待核对就不画一块空框');
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});

test('为什么这么建议：basedOn 里的判断可以点开（不是一段死文字）',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const c={workspace:'w',actor:'t',canWrite:true};
 const seedJ=store.draft(c,{title:'判断',changes:[{op:'create',id:'j1',kind:'judgment',data:{title:'合作结构有风险',status:'checking',validFrom:'2026-09-01',evidence:[{kind:'file',ref:'纪要#3',quote:'原文'}]}}]});
 store.commit(c,{batchId:seedJ.id,revision:1,key:'j1'});
 const advice=store.draft(c,{title:'建议：先做技术适配',proposal:{evidence:[{kind:'file',ref:'纪要#3',quote:'原文'}],uncertainty:'还没实测',basedOn:['j1'],decision:'undecided'},changes:[{op:'create',id:'t1',kind:'task',data:{title:'跑 decode 验证'}}]});
 void advice;
 const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 const inbox=createInbox(document,send,batch,{notify:()=>{}});
 const opened=[];inbox.setOpenRecord(id=>opened.push(id));
 const root=document.querySelector('#knowbody');
 try{
  await inbox.render(root);
  const why=root.querySelector('[data-why]');
  assert.ok(why,'有建议就要有「为什么这么建议」');
  why.open=true;why.dispatchEvent(new dom.window.Event('toggle'));
  await new Promise(resolve=>setTimeout(resolve,60));
  const links=[...root.querySelectorAll('[data-why-open]')];
  assert.equal(links.length,1,'basedOn 的每条判断都要可点');
  assert.match(links[0].textContent,/合作结构有风险/);
  links[0].click();
  assert.deepEqual(opened,['j1']);
 }finally{inbox.dispose();batch.dispose();store.close();dom.window.close()}
});
