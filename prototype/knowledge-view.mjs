import {escapeHtml as esc} from './project-render.mjs';
import {mountCalendar} from './calendar-view.mjs';
import {eventModel,compareEvents} from './event-model.mjs';
import {showEmpty} from './empty-state.mjs';
import {downloadText} from './download.mjs';
import {judgmentDocument,exportPreview} from './judgment-export.mjs';
const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
/** 核验状态只反映 Agent 实际写入的结果；没有记录就是未核验，绝不显示成已核验。 */
export const verifyLabel=verification=>{
 if(!verification?.status)return '未核对来源';
 const at=typeof verification.checkedAt==='string'?verification.checkedAt.slice(0,10):'';
 if(verification.status==='verified')return '已核对来源'+(at?' '+at:'');
 if(verification.status==='missing')return '来源中未找到'+(at?' '+at:'');
 return '无法核对来源'+(at?' '+at:'');
};
export const linkLabels={ok:'链接可用',expired:'链接已失效',unknown:'链接状态未核对来源'};
/** 简报卡片：只呈现登记过的字段，缺失一律写「未记录」。 */
/** 文件与资料卡片：把"这是哪个文件的第几版、多大、还能不能打开、归哪个项目"直接写在卡上。
 *  文件大小与是否可打开要问宿主（artifact_state）——卡片先渲染，异步补上，读不到就如实写"未能核对"。 */
function fileCard(x,live){
 const d=x.data;
 const project=live.find(item=>item.id===d.projectId);
 const linkedTasks=Array.isArray(d.taskIds)?d.taskIds.length:0;
 const path=d.path?`<span class="chip" title="${esc(d.path)}">${esc(d.path.length>34?d.path.slice(0,31)+'…':d.path)}</span>`:'<span class="chip">仅正文（没有文件路径）</span>';
 return `<button class="surface resource" data-id="${esc(x.id)}">${icon('doc')}<h2>${esc(d.title||d.name||'未命名')}</h2>
<p>${esc((d.description||d.content||'尚无摘要').slice(0,200))}</p>
<span class="filemeta" data-filemeta="${esc(x.id)}">${path}<span class="chip">大小：核对中…</span><span class="chip">状态：核对中…</span>${project?`<span class="chip">归属：${esc(project.data.title)}</span>`:'<span class="chip">归属：未归属</span>'}${linkedTasks?`<span class="chip">关联任务 ${linkedTasks}</span>`:''}</span>
<small>${d.fileVersion?'版本 '+esc(d.fileVersion):'未记录版本'} · ${esc(d.mime||'类型未记录')} · <span class="fileopen" data-fileopen="${esc(x.id)}">打开</span></small></button>`;
}
function briefCard(x){
 const d=x.data,link=d.linkStatus?linkLabels[d.linkStatus]:'链接状态未记录';
 return `<button class="surface resource" data-id="${esc(x.id)}">${icon('knowledge')}<h2>${esc(d.title||'未命名简报')}</h2><p>${esc((d.content||'尚无摘要').slice(0,200))}</p><small>来源：${esc(d.source||'未记录')}${d.sourceUrl?' · '+esc(d.sourceUrl.length>32?d.sourceUrl.slice(0,29)+'…':d.sourceUrl):''} · 发布：${esc(d.publishedAt||'未记录')} · 登记：${esc(d.fetchedAt||'未记录')} · ${esc(link)}</small>${d.uncertainty?`<small>不确定性：${esc(d.uncertainty)}</small>`:''}</button>`;
}
// 判断卡（宪章第三条 / VI V2）：判断是一等公民，卡片上必须能看到依据条数、
// 不确定性、什么时候成立与状态。依据正文在详情里就地展开，不跳页。
function judgmentCard(x){
 const d=x.data||{};
 const state={current:'✓ 当前有效',checking:'◇ 待核对',overturned:'↩ 已被推翻'}[d.status]||d.status||'状态未记录';
 const count=Array.isArray(d.evidence)?d.evidence.length:0;
 return `<button class="surface resource" data-id="${esc(x.id)}">${icon('knowledge')}<h2>${esc(d.title||'未命名判断')}</h2>`+
  (d.description?`<p>${esc(String(d.description).slice(0,200))}</p>`:'')+
  `<small>判断 · ${esc(state)} · 依据 ${count} 条 · 什么时候成立 ${esc(d.validFrom||'未记录')}${d.reviewBy?' · 复核 '+esc(d.reviewBy):''}</small>`+
  (d.uncertainty?`<small>不确定性：${esc(String(d.uncertainty).slice(0,140))}</small>`:'<small>未标不确定性</small>')+
  // 分享边界逐条可见（F17）；缺省就是「仅自己」——宁可少分享。
  `<small data-share="${esc(d.share==='team'?'team':'private')}">${d.share==='team'?'可以给同事看':'仅自己'}</small>`+
  '</button>';
}
const formatSize=bytes=>bytes<1024?bytes+' B':bytes<1024*1024?(bytes/1024).toFixed(1)+' KB':(bytes/1024/1024).toFixed(1)+' MB';
const titles={topics:['研究议题','topic'],brief:['信息简报','artifact'],files:['文件与资料','artifact'],memory:['长期记忆','memoryRef'],inbox:['材料与变更','batch']};
export function mountKnowledge(document,items,mode='topics',{open,openFiles,openSearch,renderInbox,send,openFile,notify,onBriefResolve=null}={}){
 if(!Object.hasOwn(titles,mode))throw Error('未知知识视图');
 for(const b of document.querySelectorAll('#knowtabs [data-know]')){b.classList.toggle('active',b.dataset.know===mode);b.setAttribute('aria-pressed',String(b.dataset.know===mode));}
 const root=document.querySelector('#knowbody');
 // PRD v1.1 §3：收件箱是「知识」的二级视图，与对话共用同一批批次，不新增一级导航。
 // 渲染错误由调用方（控制器）统一上报，这里不产生未捕获拒绝。
 if(mode==='inbox'){renderInbox?.(root);return {dispose(){root.replaceChildren()}}}
 const live=items.filter(x=>!x.archived),kind=titles[mode][1];
 // 信息简报按 brief 类型渲染：只展示真实登记的来源与时间，缺项写「未记录」，绝不推断。
 // 判断纳入研究议题列表（不新增入口）；「只看待核对」是**同一个列表的筛选条件**，不是新页面（03 F7）。
 const baseRows=mode==='brief'?live.filter(x=>x.kind==='brief'):mode==='topics'?live.filter(x=>x.kind==='topic'||x.kind==='judgment'):live.filter(x=>x.kind===kind);
 let filter='all';
 // 待核对数量来自真实数据（安静：只显示真实数量，不用红点、不催）
 const waitingCount=()=>baseRows.filter(x=>x.kind==='judgment'&&x.data?.status==='checking').length;
 const rows=()=>filter==='checking'?baseRows.filter(x=>x.kind==='judgment'&&x.data?.status==='checking'):baseRows;
 // 长期记忆：先把"同步方式"和"核对来源状态"说清楚——工作台不直连 Mnemon，
 // 引用由人或 Agent 登记、由 Agent 用记忆工具核验；这里只如实统计，不假装已同步。
 const memorySummary=()=>{
  if(mode!=='memory')return '';
  const refs=live.filter(x=>x.kind==='memoryRef');
  if(!refs.length)return '';
  const status=ref=>ref.data?.verification?.status??'unverified';
  const unverified=refs.filter(ref=>status(ref)==='unverified').length;
  const latest=refs.map(ref=>ref.data?.verification?.checkedAt).filter(Boolean).sort().pop();
  return `<p class="notice" data-memory-summary="1">共 ${refs.length} 条引用 · ${unverified?unverified+' 条未核对来源':'全部已核对来源'}${latest?' · 最近核对来源 '+esc(String(latest).slice(0,10)):''}<br>与记忆库的同步方式：由 Agent 用记忆工具去来源里实际核对，再把结论记回这里；工作台不直连记忆库，也不会自动改写记忆。"没核对过"不等于来源有效：只有真的核对过的引用，才代表当时在来源里找到了。</p>`;
 };
 const click=e=>{const chip=e.target.closest('[data-know-filter]');
  if(chip){filter=chip.dataset.knowFilter==='checking'?'checking':'all';paint();return}
  const action=e.target.closest('[data-know-act]');
  if(action){
   if(action.dataset.knowAct==='files'){openFiles?.();return}
   if(action.dataset.knowAct==='export'){
    // 分享是一个动作，不是一条流程（交互律 10）：就地给出数量预览，确认才下载。
    const all=live.filter(x=>x.kind==='judgment');
    const {shared,excluded,total}=exportPreview(all);
    const row=document.querySelector('#knowbody [data-kxport="1"]');
    if(!row)return;
    row.innerHTML=`<p class="notice" data-exportpreview="1">将分享 ${shared} 条 · 剔除 ${excluded} 条仅自己（共 ${total} 条判断）</p>`
      +`<button class="btn primary" data-exportgo="1">导出</button><button class="btn txt" data-exportcancel="1">取消</button>`;
    row.hidden=false;
    return;
   }
   openSearch?.();return
  }
  if(e.target.closest('[data-exportcancel]')){const row=document.querySelector('#knowbody [data-kxport="1"]');if(row){row.hidden=true;row.textContent=''}return}
  const go=e.target.closest('[data-exportgo]');
  if(go){
   const all=live.filter(x=>x.kind==='judgment');
   const {shared,excluded}=exportPreview(all);
   if(!shared){notify?.('没有可以分享的判断：把某条标为「可以给同事看」后才会出现在文档里',true);return}
   // 出处要翻译成人话（2026-10-16 判据 6 验收发现）：文档是给**别人**看的，
   // `art-xxx` 这种内部编号对他毫无意义。这里用手上已加载的对象把编号换成标题；
   // 换不到就由生成器说"这条判断引用的资料"，**不退回裸编号**。
   const byId=new Map(live.map(item=>[item.id,item]));
   const resolve=ref=>{
    const hit=byId.get(ref);
    if(hit?.data?.title)return hit.data.title+(hit.data.path?`（${hit.data.path}）`:'');
    const ranged=/^(.+)@\d+-\d+$/.exec(ref??'');
    if(ranged&&byId.get(ranged[1])?.data?.title)return byId.get(ranged[1]).data.title+' 的对应段落';
    return null;
   };
   const text=judgmentDocument(all,{at:new Date().toISOString(),resolve});
   downloadText(document,'判断记录-'+new Date().toISOString().slice(0,10)+'.md',text);
   notify?.(`已导出 ${shared} 条判断${excluded?`，剔除了 ${excluded} 条仅自己`:''}`);
   return;
  }
  const opened=e.target.closest('[data-fileopen]');
  if(opened&&openFile){openFile(opened.dataset.fileopen);return}
  const button=e.target.closest('[data-id]');if(button)open?.(button.dataset.id)};root.removeEventListener('click',click);root.addEventListener('click',click);
 const paint=()=>{root.innerHTML=memorySummary()+`<div class="modalactions" style="justify-content:flex-start;margin:0 0 var(--ws-space-16)">${mode==='files'?'<button class="btn" data-know-act="files">打开授权目录</button>':''}${mode==='topics'?'<button class="btn" data-know-act="search">知识检索</button><button class="btn" data-know-act="export">导出判断</button>'+`<button class="btn${filter==='checking'?' primary':''}" data-know-filter="${filter==='checking'?'all':'checking'}" aria-pressed="${filter==='checking'}">只看待核对 ${waitingCount()}</button>`:''}</div><div class="kexport" data-kxport="1" hidden></div><div class="resourcegrid">${rows().map(x=>mode==='brief'?briefCard(x):mode==='files'?fileCard(x,live):x.kind==='judgment'?judgmentCard(x):`<button class="surface resource" data-id="${esc(x.id)}">${icon(mode==='files'?'doc':'knowledge')}<h2>${esc(x.data.title||x.data.name||'未命名')}</h2><p>${esc((x.data.description||x.data.content||'尚无摘要').slice(0,200))}</p><small>${esc(x.data.source||x.data.provider||'已保存的记录')}${mode==='memory'?' · '+esc(verifyLabel(x.data.verification)):''}</small></button>`).join('')||'<p>暂无数据，可通过页面或 DSH 对话创建。</p>'}</div><p class="notice">${mode==='brief'?'简报由 Agent 或你授权后登记，每条都必须带来源和登记时间。定时抓取、去重和自动摘要还没接通，所以这里不会凭空出现简报。':mode==='memory'?'工作台只登记"引用"这件事本身；要不要去来源里核实，由 Agent 用记忆工具去做，再把结果记回来——工作台自己不会去读记忆库。"没核对过"不等于来源有效。':''}</p>`;
 // 信息简报：这个页签原来只有"入口"，没有任何东西在产生简报。现在把**简报引擎**的结果接在这里：
 // 它是"我的判断"，不是信息汇总 —— 每条三行：我认为什么 / 凭什么 / 你只需要回一句。
 // 引擎只算不写（`briefing` 是只读动作）：要不要采纳，仍然由人决定（宪章四）。
 if(mode==='brief'&&send){
  void (async()=>{
   let briefing=null;
   try{briefing=await send('briefing')}catch{briefing=null}
   if(briefing===null||!root.isConnected)return;
   const before=root.querySelector('[data-briefing]');
   if(before)before.remove();
   const box=document.createElement('section');
   box.className='briefing';box.dataset.briefing='1';
   if(briefing.empty){
    // 没内容就不生成空简报（宪章六·安静）—— 如实说没什么事，而不是摆一堆空位。
    box.innerHTML='<p class="notice" style="margin:0">'+esc(briefing.headline)+'。</p>';
   }else{
    box.innerHTML='<h3 style="margin:0 0 var(--ws-space-8)">'+esc(briefing.headline)+'</h3>'
     +briefing.sections.map(section=>'<div class="briefsection"><h4>'+esc(section.title)+'（'+section.items.length+'）</h4>'
      +section.items.map(item=>'<div class="briefitem">'
       +'<p class="briefwhat">'+esc(item.what)+'</p>'
       +'<p class="briefwhy">为什么现在告诉你：'+esc(item.why)+'</p>'
       +(item.evidence??[]).map(line=>'<p class="briefev">依据：'+esc(line)+'</p>').join('')
       +'<p class="briefact">你可以：'+esc(item.action)+'</p>'
       +(item.resolve?'<button class="btn" data-briefresolve="'+esc(item.resolve.id)+'" data-brieflabel="'+esc(item.resolve.label)+'">'+esc(item.resolve.label)+'</button>':'')
      +'</div>').join('')
     +'</div>').join('');
   }
   // 「回一句就闭环」：确定的那几种结论做成按钮 —— 点一下直接生效 + 左下可撤销（契约②）。
   // 不假装这里能懂自由文本：说不清的，界面就写"去 DSH 里回一句"（那是真正能听懂人话的地方）。
   for(const button of box.querySelectorAll('[data-briefresolve]')){
    button.onclick=async()=>{
     button.disabled=true;
     try{
      const {item}=await send('get',{id:button.dataset.briefresolve});
      // 结论的翻译在调用方（它才知道每个说法对应什么改动）——这里只负责"点了、拿到了、交出去"。
      await onBriefResolve?.(item,button.dataset.brieflabel);
     }catch(error){notify?.(error.message,true)}
     finally{if(button.isConnected)button.disabled=false}
    };
   }
   const grid=root.querySelector('.resourcegrid');
   if(grid)root.insertBefore(box,grid);else root.append(box);
  })();
 }
 // 异步补文件大小与磁盘状态（读不到就写"未能核对"，不猜）。
 if(mode==='files'&&send){
  void (async()=>{
   for(const x of rows().slice(0,20)){
    const holder=root.querySelector('[data-filemeta="'+x.id+'"]');
    if(!holder)continue;
    let state=null;
    try{state=await send('artifact_state',{id:x.id})}catch{state=null}
    const chips=[...holder.querySelectorAll('.chip')];
    const sizeChip=chips[1],stateChip=chips[2];
    if(sizeChip)sizeChip.textContent='大小：'+(Number.isFinite(state?.size)?formatSize(state.size):x.data.content?formatSize(new TextEncoder().encode(x.data.content).length):'未记录');
    if(stateChip){
     const labels={current:'与磁盘一致',changed:'磁盘已变化',missing:'文件不存在',ungranted:'目录未授权',unknown:'无法确认'};
     stateChip.textContent='状态：'+(labels[state?.status]??'未能核对');
     stateChip.dataset.state=state?.status??'unknown';
     if(state?.status&&state.status!=='current')stateChip.classList.add('warn');
    }
   }
  })();
 }

 // VI 空态：说明当前状态并给出下一步，而不是一句“暂无数据”。
 if(!rows().length){const grid=root.querySelector('.resourcegrid');if(grid)showEmpty(grid,{illustration:mode==='memory'?'knowledge':'empty',title:mode==='brief'?'还没有登记简报':mode==='memory'?'还没有记忆引用':mode==='files'?'还没有资料记录':'还没有研究议题',description:mode==='brief'?'简报由 Agent 或你授权后登记，每条都要带来源与登记时间；自动抓取与摘要还没接通。':mode==='memory'?'在新建里登记记忆引用后，这里会显示来源与摘录。':mode==='files'?'可以从授权目录读取文本，或把知识检索的摘录保存为资料。':'可以新建研究议题，或从知识检索里保存证据。'})}
 };
 paint();
 return {dispose(){root.removeEventListener('click',click)}};
}
export function mountPersonal(document,items,mode='calendar',{open,onSyncApple}={}){
 let calendarView=null;
 if(!['calendar','travel','invoice'].includes(mode))throw Error('未知事务视图');
 for(const b of document.querySelectorAll('#personaltabs [data-personal]')){b.classList.toggle('active',b.dataset.personal===mode);b.setAttribute('aria-pressed',String(b.dataset.personal===mode));}
 const root=document.querySelector('#personalbody'),live=items.filter(x=>!x.archived);
 const eventType=x=>x.data.eventType||'meeting';
 // Calendar shows internal meetings and other affairs; travel and invoices are separate views.
 const rows=live.filter(x=>x.kind==='event'&&((mode==='calendar'&&['meeting','other'].includes(eventType(x)))||(mode==='travel'&&eventType(x)==='travel')||(mode==='invoice'&&eventType(x)==='invoice'))).sort(compareEvents);
 // 到期与逾期：任务和交付项的日期本来就存在，这里把它们放进日程视图——
 // 这才是"任务信息和日历联动"的实际含义（外部日历同步仍未接入）。
 const dueItems=()=>{
  if(mode!=='calendar')return '';
  const today=new Date().toISOString().slice(0,10);
  const due=[];
  for(const task of live.filter(x=>x.kind==='task'&&x.data.dueDate)){
   const late=task.data.dueDate<today&&task.data.status!=='done';
   due.push({id:task.id,title:task.data.title,date:task.data.dueDate,late,kind:'任务'});
  }
  for(const project of live.filter(x=>x.kind==='project')){
   for(const item of project.data.deliverables??[]){
    if(!item.dueDate)continue;
    const late=item.dueDate<today&&item.done!==true&&item.status!=='done';
    due.push({id:project.id,title:item.title,date:item.dueDate,late,kind:'交付项 · '+project.data.title});
   }
  }
  if(!due.length)return '<div class="surface pad" data-due="empty"><h2>到期与逾期</h2><p class="notice">任务与交付项都还没有填写日期。填了日期才会出现在这里。</p></div>';
  due.sort((a,b)=>a.date.localeCompare(b.date));
  const late=due.filter(item=>item.late).length;
  return `<div class="surface pad" data-due="1"><h2>到期与逾期${late?' · '+late+' 项已逾期':''}</h2>${due.slice(0,10).map(item=>`<button class="scheduleline" data-id="${esc(item.id)}"><time>${esc(item.date.slice(5))}</time><div><strong>${esc(item.title)}</strong><p>${esc(item.kind)}${item.late?' · 已逾期':''}</p></div></button>`).join('')}${due.length>10?`<p class="notice">另有 ${due.length-10} 项未显示。</p>`:''}</div>`;
 };
 if(mode==='calendar'){
  // 苹果日历风格的月/周网格；下面保留原来的列表（切到"列表"看）。
  root.innerHTML=dueItems()+`<div class="surface pad"><div class="callayer"><div id="calbody"></div></div><h2 data-callisthead="1">列表</h2>${rows.map(x=>{const e=eventModel(x);const synced=Boolean(x.data?.externalUid);return `<button class="scheduleline" data-id="${esc(e.id)}"><time>${esc(e.label)}</time><div><strong>${esc(e.title)}</strong><p>${esc(e.location)}${synced?'':' · 未同步到苹果日历'}</p></div>${synced?'<span class="chip" data-calendar-synced="1">已同步</span>':'<span class="chip" data-calendar-pending="1">未同步</span>'}</button>`}).join('')||'<p>今日暂无日程。</p>'}</div>`}else{root.innerHTML=`<div class="surface pad"><h2>${mode==='travel'?'行程':'票据归档'}</h2>${rows.map(x=>{const e=eventModel(x);return `<button class="scheduleline" data-id="${esc(e.id)}"><time>${esc(e.label)}</time><div><strong>${esc(e.title)}</strong><p>${esc(e.location)}</p></div></button>`}).join('')||`<p>暂无${mode==='travel'?'行程':'票据'}记录。</p>`}<p class="notice">暂无外部${mode==='travel'?'行程':'票据'}服务接入；这里只显示工作区内部记录。</p></div>`}
 // 有未同步的日程时，给一条明确的下一步（不静默、也不需要用户去找入口）。
 if(mode==='calendar'){const pending=rows.filter(x=>!x.data?.externalUid).length;if(pending){const bar=document.createElement('div');bar.className='surface pad';bar.dataset.calendarHint='1';bar.innerHTML=`<p>有 ${pending} 条日程还没有同步到苹果日历。</p>`;const action=document.createElement('button');action.className='btn primary';action.type='button';action.dataset.calendarSyncNow='1';action.textContent='同步到苹果日历';action.onclick=()=>onSyncApple?.();bar.append(action);root.append(bar)}}
 const click=e=>{const b=e.target.closest('[data-id]');if(b)open?.(b.dataset.id)};root.addEventListener('click',click);
 // 日历视图（月/周）：与列表并存，切"月/周"看网格，"列表"看原来的行。
 if(mode==='calendar'){
  const region=root.querySelector('#calbody');
  if(region){calendarView=mountCalendar(document,items,{open,region});calendarView.render()}
 }
 // VI 空态：区分「今天没有安排」「尚无行程」「尚无票据」，并说明外部服务未接入。
 if(!rows.length)showEmpty(root,{illustration:mode==='calendar'?'complete':'empty',title:mode==='calendar'?'今天没有安排':mode==='travel'?'还没有行程':'还没有票据',description:mode==='calendar'?'内部日程为空。可以在这里新建日程；苹果日历同步已经接入，在「苹果日历同步」里可以双向同步或从其它日历导入。':mode==='travel'?'外部行程服务还没接上，这里只显示工作台里记下的行程。':'票据识别服务未接入，这里只显示工作区内部记录。'});
 return {dispose(){root.removeEventListener('click',click);calendarView?.dispose()}};
}
