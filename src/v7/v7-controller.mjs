import {createWorkspaceApi,readWorkspaceItems} from './api.mjs';
import {mountNavigation} from './navigation.mjs';
import {mountProjectViews} from './project-view.mjs';
import {mountTaskViews} from './task-view.mjs';
import {createProjectDetail} from './project-detail.mjs';
import {createTaskDetail} from './task-detail.mjs';
import {sharedModal} from './modal.mjs';
import {mountOverview} from './overview-view.mjs';
import {mountKnowledge,mountPersonal} from './knowledge-view.mjs';
import {mountFind} from './find.mjs';
import {mountAppleCalendar} from './apple-calendar-view.mjs';
import {createRecordDetail} from './record-detail.mjs';
import {createBatchFlow} from './batch.mjs';
import {createEditor} from './editor.mjs';
import {mountSpace} from './space-view.mjs';
import {createInbox} from './inbox.mjs';
import {createIntake} from './intake.mjs';
import {createFiles} from './files.mjs';
import {createKnowledgeSearch} from './knowledge-search.mjs';
import {createLoading} from './loading.mjs';
import {mountPendingBadge} from './pending-badge.mjs';
import {escapeHtml as esc} from './project-render.mjs';

/** 点「去 DSH 对话」：嵌入态请宿主客户端半开新会话；600ms 无 ack 或独立页 → 同源跳 /。
 *  抽成纯函数是为了让"一次点击后能立即输入"这条判据可测，而不是只能靠人眼看。 */
export function openDshChat(win,{settleMs=600,onFallback}={}){
 const fallback=()=>{try{win.top?.location?.assign?.('/')}catch{/* 跨域不可访问时什么都不做 */}onFallback?.()};
 if(!win.parent||win.parent===win){try{win.location.assign('/')}catch{};return}
 let acked=false;
 const onAck=event=>{if(event?.data?.type==='workstation:open-chat-ack'){acked=true;try{win.removeEventListener('message',onAck)}catch{}}};
 try{win.addEventListener('message',onAck)}catch{}
 try{win.parent.postMessage({type:'workstation:open-chat'},win.location?.origin)}catch{try{win.location.assign('/')}catch{};fallback();return}
 setTimeout(()=>{try{win.removeEventListener('message',onAck)}catch{};if(!acked)fallback()},settleMs);
}

export async function mountV7(document,{workspace,fetch:request=globalThis.fetch,onError=()=>{},notify=()=>{},confirm,openGraph,openIntake}){
 let epoch=0,current=true,projectViews,taskViews,overviewView,knowledgeView,personalView,spaceView;
 // W2-1 页面标题：冻结外壳的 #title 是隐藏的 div（用户 2026-10-10 拍板不要页头大口号），
 // 但它仍是"页面标题"这个语义位置。运行期换成 h1（仍然隐藏、视觉不变），给字阶与无障碍一个真标题。
 {
  const legacy=document.querySelector('#title');
  if(legacy&&legacy.tagName!=='H1'){
   const heading=document.createElement('h1');
   heading.id='title';heading.className=legacy.className;heading.hidden=legacy.hidden;heading.textContent=legacy.textContent;
   legacy.replaceWith(heading);
  }
 }
 const loading=createLoading(document);
 const pendingBadge=mountPendingBadge(document);
 const send=createWorkspaceApi(workspace,{fetch:request,isCurrent:()=>current});
 const report=operation=>Promise.resolve().then(operation).catch(error=>{if(current)onError(error)});
 // 提交成功后：如果这批里有事务（新建/更新/归档），自动推到苹果日历。
 // 注意必须在**确认提交之后**——编辑器只是生成草稿，草稿阶段还没有记录可推。
 const batch=createBatchFlow(document,send,{notify,confirm,onCommitted:async result=>{
  await report(load);
  const events=(result?.after??[]).filter(item=>item?.kind==='event').length
   ||(result?.changes??[]).filter(item=>item?.kind==='event').length;
  try{
   if(events)await syncAppleNow('push',{silent:true});
  }catch{/* 同步失败不影响提交结果，用户仍可手动同步 */}
 }});
 const editor=createEditor(document,send,batch,{notify,onIntake:()=>report(()=>intake.open())});
 const editItem=(kind,item)=>report(()=>editor.open(kind,item));
 const inbox=createInbox(document,send,batch,{notify,projects:[],onCommitted:receipt=>batch.showSaved('已同意 '+receipt?.changes?.length+' 项改动',receipt),openLogin:()=>report(async()=>{
  const response=await request('/personal-workstation/browser-login',{method:'POST',headers:{'x-workstation-client':'1'}});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(value.error||'无法生成登录入口');
  const modal=sharedModal(document),ticket=modal.begin();if(ticket===null)return;
  modal.present(ticket,{title:'在浏览器中登录 DSH',type:'本机浏览器',html:`<p>登录后可在本机浏览器中打开需要 DSH 会话的预览（含 Office）。此入口授予当前 DSH 浏览器访问权限，请勿分享。</p><div class="modalactions"><a class="btn primary" href="${esc(value.url)}" target="_blank" rel="noopener noreferrer">打开本机浏览器登录</a></div>`});
 })});
 const files=createFiles(document,send,{notify,workspace,fetchImpl:request,onBatch:id=>report(()=>batch.open(id)),onArtifact:({path,grantId,content})=>report(()=>batch.draft('关联文件为资料记录',[{op:'create',kind:'artifact',data:{title:path.split('/').pop()||path,path,fileGrantId:grantId,content,description:'由文件与资料页关联的文本当时的副本。'}}]))});
 const knowledgeSearch=createKnowledgeSearch(document,send,batch,{notify});
 // 全类型查找：知识页顶部的查找框（用户反馈"找不到会议纪要"）。
 const finder=mountFind(document,{send,open:id=>report(()=>recordDetail.open(id)),notify});
 // 苹果日历同步（日程与事务页的入口；写入目标日历、导入只生成草稿）
 const appleCalendar=mountAppleCalendar(document,{send,openBatch:id=>report(()=>batch.open(id)),notify});
 // 「录入」：粘贴 / 选择文件 / 拖放 / 链接 / 目标项目 / 目标任务 → 同一批草稿（体检 A4）。
 const intake=createIntake(document,send,batch,{notify,openSearch:()=>knowledgeSearch.open(),onBatch:id=>report(()=>batch.open(id))});
 // 详情里的「在画布中查看关联」：切到画布并聚焦该对象（原型在 open 后追加同一入口）。
 const openCanvas=id=>report(()=>{navigation.show('space');spaceView?.focusNode(id)});
 // 关联已有材料：列出还没归到本项目的资料，点一下就生成关联变更（仍然要经收件箱确认）。
 /** 任务详情「关联已有材料」：把选中的资料追加到该任务的 taskIds（多对多，走同一批草稿）。 */
 async function linkMaterialToTask(task){
  let items=[];
  try{items=(await send('list',{kind:'artifact',limit:500})).items.filter(item=>!item.archived)}catch{items=[]}
  const candidates=items.filter(item=>!(Array.isArray(item.data?.taskIds)&&item.data.taskIds.includes(task.id)));
  const request=sharedModal(document).begin();
  if(request===null)return;
  const rows=body=>{
   body.replaceChildren();
   if(!candidates.length){const p=document.createElement('p');p.className='notice';p.textContent='没有可关联的资料了：这份任务已经挂上了现有资料。';body.append(p);return}
   for(const item of candidates){
    const row=document.createElement('div');row.className='modalactions';
    const label=document.createElement('span');label.textContent=(item.data.title||item.id)+(item.data.path?'（'+item.data.path+'）':'');
    const link=document.createElement('button');link.className='btn';link.dataset.tasklink=item.id;link.textContent='关联到本任务';
    link.onclick=async()=>{
     link.disabled=true;
     try{
      const taskIds=[...(Array.isArray(item.data.taskIds)?item.data.taskIds:[]),task.id];
      await (typeof batch.apply==='function'?batch.apply:batch.draft)('关联材料到任务：'+(item.data.title??item.id),[{op:'update',id:item.id,expectedRevision:item.revision,data:{...item.data,taskIds},sources:{taskIds:'用户在任务详情关联已有材料'}}]);
      sharedModal(document).close();
      await load();
     }catch(error){notify(error.message,true);link.disabled=false}
    };
    row.append(label,link);body.append(row);
   }
  };
  if(!sharedModal(document).present(request,{title:'关联已有材料',type:'选择材料',html:'<p class="notice">选中的资料会同时挂到这份任务上；一份材料可以支撑多个任务，资料本身与服务端文件不会被改动。</p><div id="tasklinkbody"></div>'}))return;
  rows(document.querySelector('#tasklinkbody'));
 }
 async function linkMaterial(projectId){
  const {items}=await send('list',{kind:'artifact',limit:200});
  const candidates=items.filter(item=>!item.archived&&item.data.projectId!==projectId);
  const request=sharedModal(document).begin();
  if(request===null)return;
  const rows=body=>{
   body.replaceChildren();
   if(!candidates.length){const p=document.createElement('p');p.className='notice';p.textContent='没有可关联的资料。可以先到「知识 → 文件与资料」登记，或为这个项目录入。';body.append(p);return}
   for(const item of candidates){
    const row=document.createElement('div');row.className='modalactions';
    const label=document.createElement('span');label.textContent=(item.data.title||item.id)+(item.data.path?'（'+item.data.path+'）':'');
    const link=document.createElement('button');link.className='btn';link.textContent=item.data.projectId?'改归本项目':'关联';
    link.onclick=async()=>{
     link.disabled=true;
     try{
      await (typeof batch.apply==='function'?batch.apply:batch.draft)('关联材料：'+item.data.title,[{op:'update',id:item.id,expectedRevision:item.revision,data:{...item.data,projectId}}]);
      sharedModal(document).close();
      await load();
     }catch(error){notify(error.message,true);link.disabled=false}
    };
    row.append(label,link);body.append(row);
   }
  };
  if(!sharedModal(document).present(request,{title:'关联已有材料',type:'选择材料',html:'<p class="notice">选中的资料会归到这个项目；资料本身与服务端文件不会被改动。</p><div id="linkmaterialbody"></div>'}))return;
  rows(document.querySelector('#linkmaterialbody'));
 }

 /** 就地改一个字段（项目详情与任务详情共用）。
  *  契约②：**自己的操作直接生效** + 左下可撤销，不为低风险改动弹确认。
  *  字段名的中文在这里统一翻译 —— 撤销条上写的是人话，不是 ownerId。 */
 /** 简报里「回一句就闭环」：把**明确的结论**翻成一次改动。
  *  只认确定的那几种说法（界面上就是按钮，不是自由文本）——说不清的走 DSH 对话，那里能听懂人话。
  *  与就地编辑同一条通路：直接生效 + 左下可撤销（契约②）。 */
 async function briefResolve(item,label){
  const patch={ '标记完成':{status:'done'}, '仍然成立':{status:'current'}, '不再等，恢复待办':{status:'todo',blockedReason:''} }[label];
  if(!patch)throw Error('这个结论还不知道怎么处理（'+label+'）。去 DSH 里回一句，我来判断。');
  await inlineChange({...item,data:{...item.data}},patch);
  await load();
 }

 /** 列出某一组对象（总览指标卡点开时用）。
  *  为什么要有它：指标卡上的数字是**一组对象的汇总**，点它就该看到**那组对象本身**。
  *  原来这里是跳到项目页/任务页 —— 跳过去看到的是**全部**，不是**这一组**，
  *  等于没回答"这个数字是哪几个凑出来的"（交互律 04「任何状态都能点回到原因」）。 */
 /** 总览「待你决定的改动 N」点开 = **就地列出这 N 条**，点其中一条打开那一条。
  *  用户 2026-10-16 的原话：「总览的一些数据点开就直接跳转了，我不需要跳转，按理应该是弹窗出现对应的列表」。 */
 function showPendingList(rows){
  const list=rows??[];
  const modal=sharedModal(document);
  const html=list.length
   ?list.map(row=>`<button class="btn" data-openpending="${esc(row.id)}" style="display:block;width:100%;text-align:left;margin:0 0 4px">${esc(row.title??row.id)}</button>`).join('')
   :'<p class="notice" style="margin:0">现在没有待你决定的改动。</p>';
  const request=modal.begin();
  if(request===null)return;
  if(!modal.present(request,{title:'待你决定的改动',type:'清单',html}))return;
  for(const button of document.querySelectorAll('[data-openpending]')){
   button.onclick=()=>{modal.close();report(()=>batch.open(button.dataset.openpending))};
  }
 }
 function showGroup(rows,label){
  const list=rows??[];
  const modal=sharedModal(document);
  const html=list.length
   ?list.map(row=>`<button class="btn" data-opengroup="${esc(row.id)}" style="display:block;width:100%;text-align:left;margin:0 0 4px">${esc(row.kind)} · ${esc(row.title)}</button>`).join('')
   :'<p class="notice" style="margin:0">这一组现在是空的。</p>';
  const request=modal.begin();
  if(request===null)return;
  if(!modal.present(request,{title:label||'这一组',type:'清单',html}))return;
  for(const button of document.querySelectorAll('[data-opengroup]')){
   button.onclick=()=>{modal.close();report(()=>recordDetail.open(button.dataset.opengroup))};
  }
 }

 async function inlineChange(item,patch){
  // **不包 report()**：就地编辑的失败必须**抛回给调用方**，让 inline-edit 还原成原值并如实提示。
  // 包住的话，写失败也会显示"已改" —— 那正是宪章第八条明令不做的「无回执的假成功」。
  {
   const field=Object.keys(patch)[0];
   const label={partnerId:'合作机构',ownerId:'负责人',startDate:'开始日期',dueDate:'截止日期',
    importance:'重要程度',urgency:'紧急程度',status:'业务状态',executionTarget:'执行端',
    title:'名称',goal:'目标 / 预期成果',
    expectedOutput:'预期成果',blockedReason:'等待原因'}[field]??field;
   await (typeof batch.apply==='function'?batch.apply:batch.draft)(
    '改「'+(item.data.title??item.id)+'」的'+label,
    [{op:'update',id:item.id,expectedRevision:item.revision,data:{...item.data,...patch}}]);
  }
  await load();
 }

 const projectDetail=createProjectDetail(document,send,{
 notify,
 batch,
 openGraph:openCanvas,
 openIntake:id=>report(()=>knowledgeSearch.open({projectId:id})),
 onIntake:id=>report(()=>knowledgeSearch.open({projectId:id})),
 onEdit:editItem,
 openTask:id=>report(()=>taskDetail.open(id)),
 openFileDialog:initial=>report(()=>files.openFile(initial)),
 // 阶段推进：写成一次真实变更（可追溯、可在收件箱里撤销），只改阶段与时间。
 onAdvanceStage:async(project,stage)=>{
  // 阶段条现在每一格都能点（2026-10-14 用户要求"左拉右拉就定"）。但**往回退**是另一回事：
  // 「验证 → 接触」意味着项目退回早期，人会据此改变对其他人的承诺 —— 契约③「硬规则当场问」。
  // 往前推进不问（这是最常见、可撤销的动作）。
  const order=['接触','需求','方案','验证','复盘'];
  const from=order.indexOf(project.data.stage??'');const to=order.indexOf(stage);
  if(from>=0&&to>=0&&to<from){
   const ok=await (confirm??(async()=>true))('把「'+project.data.title+'」从「'+project.data.stage+'」退回「'+stage+'」？','退回会记录一次阶段变化，交付项与任务不受影响。');
   if(!ok)return;
  }
  await report(async()=>{
   const now=new Date().toISOString();
   const history=[...(project.data.stageHistory??[]),{stage,at:now}];
   await (typeof batch.apply==='function'?batch.apply:batch.draft)('推进阶段：'+project.data.title+' → '+stage,[{op:'update',id:project.id,expectedRevision:project.revision,data:{...project.data,stage,stageHistory:history}}]);
  });
  await load();
 },
 // 就地改一个字段（负责人 / 合作机构 / 计划日期…）：与「编辑项目」走**同一条**写入路径 ——
 // 自己的操作直接生效 + 左下可撤销（契约②），不为低风险改动弹确认。
 onInlineChange:inlineChange,
 onNewTask:async projectId=>{await report(()=>editor.open('task',null,{projectId,status:'todo'}));await load()},
 onLinkMaterial:async projectId=>{await report(()=>linkMaterial(projectId))},
 onOpenMaterial:async id=>{await report(()=>recordDetail.open(id))},
 // 取消关联：只从材料上去掉 projectId，材料本身与服务端文件都不动。
 onUnlinkMaterial:async(artifactId,projectId)=>{
  await report(async()=>{
   const {item}=await send('get',{id:artifactId});
   if(!item||item.data.projectId!==projectId)return;
   const data={...item.data};delete data.projectId;
   await (typeof batch.apply==='function'?batch.apply:batch.draft)('取消关联材料：'+item.data.title,[{op:'update',id:item.id,expectedRevision:item.revision,data}]);
  });
  await load();
 },
});
 const taskDetail=createTaskDetail(document,send,{notify,onInlineChange:inlineChange,onEdit:editItem,openCanvas,openProject:id=>report(()=>projectDetail.open(id)),onLinkMaterial:task=>report(()=>linkMaterialToTask(task))});
 const recordDetail=createRecordDetail(document,send,{onEdit:editItem,openCanvas,onOpenFile:initial=>report(()=>files.openFile(initial)),onEditFile:options=>files.editFile(options),notify:(text,error)=>notify(text,error),openBatch:id=>report(()=>batch.open(id)),batch});
 // W3-C：收件箱「待核对」点开就是那条判断的详情（晚绑定，recordDetail 比 inbox 晚创建）。
 inbox.setOpenRecord(id=>report(()=>recordDetail.open(id)));
 let lastItems=[];
 const rerenderKnowledge=mode=>{knowledgeView?.dispose();knowledgeView=mountKnowledge(document,lastItems,mode,{onBriefResolve:briefResolve,open:id=>report(()=>recordDetail.open(id)),openFiles:()=>report(()=>files.openFile()),openSearch:()=>report(()=>knowledgeSearch.open()),renderInbox:root=>inbox.render(root).catch(error=>{if(current)onError(error)}),send,openFile:id=>report(()=>recordDetail.open(id)),notify:(text,error)=>notify(text,error)});};
 /** 一键同步到苹果日历：推送工作台的事务（操作者点击即授权），成功后刷新界面。 */
 async function syncAppleNow(mode='push',{silent=false}={}){
  try{
   const result=await send('apple_sync',{mode});
   const plan=result.plan??{};
   const moved=(plan.pushCreate??0)+(plan.pushUpdate??0)+(plan.pullCreate??0)+(plan.pullUpdate??0);
   if(!silent)notify(moved?`苹果日历同步完成：推送 ${plan.pushCreate+plan.pushUpdate} · 拉取 ${plan.pullCreate+plan.pullUpdate}`:'苹果日历已是最新（无变化）');
   await load();
  }catch(error){
   // 用户**主动点**同步 → 失败要如实说；保存路径上的自动推送 → 静默。
   // 未接入这件事已经在「设置 → 接上了什么」和「日程与事务」里写着，不需要在别人动作上再报一次。
   if(!silent)notify(error.message,true);
  }
 }
 const rerenderPersonal=mode=>{personalView?.dispose();personalView=mountPersonal(document,lastItems,mode,{open:id=>report(()=>recordDetail.open(id)),onSyncApple:()=>report(()=>syncAppleNow('both'))});};
 async function load(){
  const run=++epoch;
  // 手册 §08：先给出静态骨架（保留布局），超过 1 秒才显示「正在读取资料」。
  loading.begin();
  try{
   const items=await readWorkspaceItems(send);if(!current||run!==epoch){loading.clear();return}
   lastItems=items;
   inbox.setProjects(items.filter(x=>x.kind==='project'&&!x.archived).map(project=>({id:project.id,title:project.data.title})));
  intake.setChoices({projects:items.filter(x=>x.kind==='project'&&!x.archived).map(project=>[project.id,project.data.title]),tasks:items.filter(x=>x.kind==='task'&&!x.archived).map(task=>[task.id,task.data.title])});
   const snapshot=async(action,data)=>action==='list'?{items:items.slice(data.offset,data.offset+data.limit)}:send(action,data);
   const next=await mountProjectViews(document,snapshot,id=>report(()=>openRecord(id)),{onCreate:()=>report(()=>editor.open('project'))});
   const overviewData=await send('overview').catch(()=>null);
   const pending=overviewData?.pendingBatches??null;
   // 清单也要拿：总览上"待你决定的改动 N"点开要**就地列出**这 N 条，不是跳到收件箱（用户 2026-10-16）。
   const pendingList=overviewData?.pendingList??[];
   // 待确认数量既进总览小字，也做成侧栏/收件箱提示；读不到就不显示（不写死）。
   pendingBadge.render(pending===null?undefined:pending);
   // 指标卡点开 = **本页弹窗列出这一组**（用户 2026-10-16：「不要跳转，弹窗出现对应的列表最直观」）。
   // 弹窗在这里开，因为 modal 能力在控制器里；概览只负责说清"这一组是哪几个"。
   const nextOverview=mountOverview(document,items,{pending,onPendingList:()=>report(()=>showPendingList(pendingList)),onListGroup:(rows,label)=>report(()=>showGroup(rows,label)),openEvent:id=>report(()=>recordDetail.open(id)),openTopic:id=>report(()=>recordDetail.open(id))});
   if(!current||run!==epoch){next.dispose();nextOverview.dispose();return;}
   projectViews?.dispose();projectViews=next;overviewView?.dispose();overviewView=nextOverview;taskViews?.dispose();taskViews=mountTaskViews(document,items,id=>report(()=>taskDetail.open(id)),{onCreate:()=>report(()=>editor.open('task'))});
   const active=document.querySelector('#knowtabs [data-know].active')?.dataset.know||'topics';rerenderKnowledge(active);rerenderPersonal('calendar');
   for(const b of document.querySelectorAll('#knowtabs [data-know]'))b.onclick=()=>rerenderKnowledge(b.dataset.know);for(const b of document.querySelectorAll('#personaltabs [data-personal]'))b.onclick=()=>rerenderPersonal(b.dataset.personal);
   // 改成**函数声明**（会提升）：项目页的 open 要引用它，而它写在后面。
   // （不挪行 —— 挪动这里的顺序会打乱别的东西依赖的执行次序，实测直接把启动弄坏了。）
   function openRecord(id){const item=items.find(entry=>entry.id===id);if(item?.kind==='project')return projectDetail.open(id);if(item?.kind==='task')return taskDetail.open(id);return recordDetail.open(id)};
   spaceView?.dispose();spaceView=mountSpace(document,{send,batch,notify,projects:items.filter(x=>x.kind==='project').map(project=>({id:project.id,title:project.data.title})),open:id=>report(()=>openRecord(id)),create:()=>report(()=>editor.menu()).then(()=>load())});
   await spaceView.load();if(!current||run!==epoch){spaceView.dispose();spaceView=undefined;return;}
  }catch(error){if(current&&run===epoch)onError(error);}
  finally{loading.clear()}
 }
 // 画布只在挂载时不可见（宽度为0），切到该页必须重新适配，否则节点会被裁掉。
 const navigation=mountNavigation(document,view=>{if(view==='space')spaceView?.refit();if(view==='inbox')report(()=>inbox.render(document.querySelector('#inboxbody')))});
 const createButton=document.querySelector('#create');if(createButton)createButton.onclick=()=>report(()=>editor.menu());
 // 「空间与设置」这个入口名把两件事并成了一个词（空间 = 关联空间；设置 = 授权与状态），
 // 而契约已明确「不做工作区选择或空间切换」，这一页只剩设置。改文案走**运行时**，外壳继续与冻结原型逐字一致。
 const settingsButton=document.querySelector('#settings');
 if(settingsButton){settingsButton.lastChild.textContent='设置';settingsButton.onclick=()=>report(()=>inbox.openSettings());}
 inbox.setOpenInbox(()=>report(async()=>{navigation.show('inbox');await inbox.render(document.querySelector('#inboxbody'))}));
 // 原型中由 files.js 动态插入的“文件与资料”快捷入口，接到真实授权目录浏览。
 const shortcut=[...document.querySelectorAll('.actions .btn')].find(button=>button.textContent.includes('文件与资料'));
 if(shortcut)shortcut.onclick=()=>report(()=>files.openFile());
 const assistant=document.querySelector('#assistant');
 if(assistant){
  // W1 P0-4：同一位置、同一按钮，运行期改文案（外壳仍与冻结原型逐字一致，先例 #settings）。
  // 点击后一步到达 DSH 对话：嵌入态让宿主客户端半调 uiWorkspace.startSession()；独立态同源跳 /。
  // 不再用「说明书 + 复制粘贴」作为唯一动作（那是假动作，C8 禁止）。
  assistant.lastChild.textContent='去 DSH 对话';
  assistant.title='在工作台里不调用模型；点一下去 DSH 对话';
  assistant.onclick=()=>report(()=>openDshChat(window));
 }
 // 原型布局脚本插入的控件：录入入口与项目页的新建入口，必须接到真实流程，不能是死按钮。
 // 按文案找按钮时**剥掉开头的加号**：2026-10-14 把「＋ 录入」里的全角 ＋ 换成了 VI 加号图标，
 // 文本随之变成「录入」。原来按「加号 + 录入」的整串文本匹配，换图标后这两个按钮立刻变成**死按钮** ——
 // 是 test/v7-control-audit 的「可见控件必须有处理函数」把它挡下来的。
 const normalizeLabel=node=>node.textContent.replace(/\s+/g,'').replace(/^[＋+]/,'');
 const findButton=(scope,text)=>[...scope.querySelectorAll('button')].find(node=>normalizeLabel(node).includes(text.replace(/^[＋+]/,'')));
 // 「录入」这个入口实际在**顶栏**（原型脚本把它插进 .top .actions），原来的 findButton 只在 .hero 里找，
 // 因此这个按钮一直是死的（没有 onclick）。先按老位置找，找不到就全文档找一次，别让它继续当摆设。
 // 顶栏不再单独放「录入」：两个入口语义重叠，只留「新建」，材料进来放在菜单第一节。
 // 按钮**移除**而不是隐藏——留着就是第二个入口（用户 2026-10-14 点名）。
 // 独立走查 C7b：顶栏「文件与资料」与知识页的「文件与资料」页签是同一处内容的两条路径
 // （品味「克制 / 零重复」：一件事只留一个入口）。
 // 用户 2026-10-14 拍板：**删顶栏那个，保留知识页的页签**。
 // 注意：2026-10-10 曾确认过"不改入口清单"，所以这一条必须由用户点头才动 —— 现在他点了。
 const filesEntry=findButton(document.querySelector('.top .actions')??document,'文件与资料');
 if(filesEntry)filesEntry.remove();
 const intakeButton=findButton(document.querySelector('.top .actions')??document,'录入');
 if(intakeButton)intakeButton.remove();
 // 顶栏只剩一个创建入口了，它就该是主按钮（VI V4：每个视图最多一个主色按钮）。
 // 在**运行时**提升，外壳仍与冻结原型逐字一致。
 if(createButton)createButton.className='btn primary';
 // 「业务数据 · 按记录计算」是一句数据说明，不是动作，挤在动作排里还占两行（品味「克制」）。
 const dataNote=[...document.querySelectorAll('.top .actions .chip')].find(node=>/业务数据/.test(node.textContent));
 if(dataNote)dataNote.remove();
 const projectNew=findButton(document.querySelector('#projects')??document,'新建项目');
 if(projectNew){
  projectNew.onclick=()=>report(()=>editor.open('project'));
  // 17 C4：与顶栏「新建」是同一动作，只能留一个入口。保留元素与处理函数（回退/测试兼容），但不再显示。
  projectNew.hidden=true;
  // 有些类名（.btn/.toolbar）自带 display，hidden 属性会被作者样式盖掉；显式置空展示，确保真的不可见。
  projectNew.style.display='none';
 }
 await load();
 return {navigation,refresh:load,inbox,files,knowledgeSearch,dispose(){current=false;epoch++;projectViews?.dispose();overviewView?.dispose();taskViews?.dispose();knowledgeView?.dispose();personalView?.dispose();spaceView?.dispose();projectDetail.dispose();taskDetail.dispose();recordDetail.dispose();editor.dispose();batch.dispose();inbox.dispose();files.dispose();knowledgeSearch.dispose();if(createButton)createButton.onclick=null;if(settingsButton)settingsButton.onclick=null;if(shortcut)shortcut.onclick=null;if(assistant)assistant.onclick=null;if(intakeButton)intakeButton.onclick=null;if(projectNew)projectNew.onclick=null;for(const b of document.querySelectorAll('#knowtabs button,#personaltabs button'))b.onclick=null;sharedModal(document).dispose();navigation.dispose();}};
}
