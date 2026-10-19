import {escapeHtml as esc,ring} from './project-render.mjs';
import {projectModels} from './project-data.mjs';
import {eventModel,compareEvents,eventDayKey} from './event-model.mjs';
const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const metric=(label,value,sub,chart='',group=null)=>{
 // 交互律 04「任何状态都能点回到原因」：指标卡上的数字是**一组对象的汇总** ——
 // 点它就该看到那组对象。原来是一块点不动的静态文本："只给结论，不给依据"。
 // 有去处时才做成按钮（没有去处的仍保持静态，不为了"能点"而造一个空动作）。
 const inner=`<div><p>${label}</p><b>${value}</b><br><small>${sub}</small></div>${chart}`;
 // **不跳页**（用户 2026-10-16：「我不需要跳转，按理应该是弹窗出现对应的列表，这样最直观」）。
 // 而且跳页根本解决不了注释里那句话 —— 跳过去看到的是**全部**，不是**这一组**。
 // 改成 data-metric：点了在本页弹窗列出这一组对象。
 return group?`<button class="metric" data-metric="${group}" type="button">${inner}</button>`:`<div class="metric">${inner}</div>`;
};

export function mountOverview(document,items,{openEvent,openTopic,onListGroup,onPendingList,now=new Date(),pending=null}={}){
 const live=items.filter(x=>!x.archived),projects=projectModels(live),tasks=live.filter(x=>x.kind==='task');
 const done=projects.reduce((n,p)=>n+p.done,0),total=projects.reduce((n,p)=>n+p.total,0),waiting=tasks.filter(t=>t.data.status==='waiting').length;
 // 指标卡严格保持基线的 4 张（原 V7 与设计方 VI 应用页都是 4 张）。
 const metricsNode=document.querySelector('#metrics');
 // 副标题沿用原型的写法：等待项点名具体项目，原因未记录就如实说未记录，不写泛化文案。
 const waitingTasks=tasks.filter(t=>t.data.status==='waiting');
 const waitingProjects=[...new Set(waitingTasks.map(task=>live.find(x=>x.id===task.data.projectId)?.data.title).filter(Boolean))];
 // 体检 P1：原来无论数据里有没有原因，一律写"等待原因未记录"。现在显示真实原因；
 // 只有确实一条都没填时才写"原因未记录"——不假装，也不隐瞒。
 const reasons=[...new Set(waitingTasks.map(task=>task.data.blockedReason).filter(reason=>reason&&reason.trim()))];
 const waitingWho=waitingProjects.length?waitingProjects.slice(0,2).join('、')+(waitingProjects.length>2?` 等 ${waitingProjects.length} 个项目`:'')+' · ':'';
 const waitingSub=waitingTasks.length?(reasons.length?waitingWho+reasons.slice(0,2).join('；')+(reasons.length>2?` 等 ${reasons.length} 条原因`:''):waitingWho+'原因未记录'):'当前没有等待项';
 metricsNode.innerHTML=metric('推进中的项目',projects.length,'按交付项跟踪',icon('project'),'activeProjects')
 +metric('交付项完成',`${done}/${total}`,total?'全部项目汇总':'尚无交付项',total?ring(done,total):'','allProjects')
 +metric('运行中的任务',tasks.filter(t=>t.data.status==='in_progress').length,`另有 ${waiting} 项等待`,icon('task'),'runningTasks')
 +metric('需要解锁',waiting,waitingSub,icon('link'),'waitingTasks');
 // 点指标卡 = 去那组对象所在的页面（沿用既有的 data-goto 通道，不新造跳转）。
 // PRD v1.1 §3 要求总览展示待整理/待确认计数。基线没有这两个数字，因此用一行小字补充，
 // 不新增指标卡（那会把整个下半页推低约 21px）；待整理的定义同时写在文案里。
 for(const node of document.querySelectorAll('#home [data-counts]'))node.remove();
 if(pending!==null){
  const unorganized=live.filter(x=>(x.kind==='artifact'||x.kind==='topic')&&!x.data.projectId).length;
  const line=document.createElement('p');line.dataset.counts='1';
  // 放在指标区与下一个模块之间的既有留白里（绝对定位，不参与排版），
  // 这样既满足 PRD v1.1 §3 的计数要求，又不会把下面整段推低。
  line.style.cssText='position:absolute;right:0;bottom:-21px;margin:0;font-size:12px;color:var(--ws-muted);line-height:18px';
  // 交互律 04「任何状态都能点回到原因」+ 用户 2026-10-16：「点开数字应该是**弹窗列出对应的列表**，
  // 不要跳走」。所以这两个数字各自**就地弹窗**，不再 data-goto 到别的页面（那是"横向跳"，违反交互律 06）。
  line.textContent='';
  const pendingButton=document.createElement('button');
  pendingButton.type='button';pendingButton.className='metricnote';pendingButton.dataset.countsPending='1';
  pendingButton.textContent=`待你决定的改动 ${pending}`;
  const gap=document.createTextNode(' · ');
  const unorganizedButton=document.createElement('button');
  unorganizedButton.type='button';unorganizedButton.className='metricnote';unorganizedButton.dataset.countsUnorganized='1';
  unorganizedButton.textContent=`待整理 ${unorganized}（未归属项目的资料与议题）`;
  line.append(pendingButton,gap,unorganizedButton);
  pendingButton.onclick=()=>onPendingList?.();
  unorganizedButton.onclick=()=>onListGroup?.(
   live.filter(x=>(x.kind==='artifact'||x.kind==='topic')&&!x.data.projectId)
    .map(x=>({id:x.id,kind:x.kind==='artifact'?'资料':'研究议题',title:x.data.title??x.id})),
   '待整理（未归属项目的资料与议题）');
  metricsNode.style.position='relative';
  metricsNode.appendChild(line);
 }
 const lower=document.querySelector('#home .lower'),timeline=lower.children[0],news=lower.children[1];
 for(const row of timeline.querySelectorAll('.scheduleline,[data-empty]'))row.remove();
 const todayKey=eventDayKey(now);
 const events=live.filter(x=>x.kind==='event'&&eventModel(x).dayKey===todayKey).sort(compareEvents);
 for(const item of events){const model=eventModel(item);const row=document.createElement('button');row.className='scheduleline';row.dataset.event=item.id;row.style.cssText='width:100%;text-align:left';row.innerHTML=`<time>${esc(model.allDay?'全天':model.label.replace(/^\S+\s/,''))}</time><div><strong>${esc(model.title)}</strong><p>${esc(item.data.location||'地点未设置')}</p></div>`;timeline.append(row);}
 if(!events.length){const empty=document.createElement('p');empty.dataset.empty='';empty.textContent='今日暂无日程';timeline.append(empty);}
 for(const row of news.querySelectorAll('[data-topic],[data-empty]'))row.remove();
 const topics=live.filter(x=>x.kind==='topic').slice(0,2);const more=news.querySelector('[data-goto]');
 for(const item of topics){const row=document.createElement('button');row.className='news';row.dataset.topic=item.id;row.innerHTML=`<h3>${esc(item.data.title)}</h3><p>${esc(item.data.summary||item.data.description||'研究议题')}</p>`;news.insertBefore(row,more);}
 if(!topics.length){const empty=document.createElement('p');empty.dataset.empty='';empty.textContent='暂无研究议题';news.insertBefore(empty,more);}
 // 指标卡点开 = **列出这一组对象**（用户 2026-10-16：「应该是弹窗出现对应的列表，这样最直观」）。
 // 这里只负责"这一组是哪几个"，弹窗由调用方开（它才拿得到 modal 能力）。
 const groupRows=key=>{
  if(key==='activeProjects')return items.filter(x=>x.kind==='project'&&!x.archived).map(x=>({id:x.id,kind:'项目',title:x.data?.title??x.id}));
  if(key==='allProjects')return items.filter(x=>x.kind==='project'&&!x.archived).map(x=>({id:x.id,kind:'项目',title:x.data?.title??x.id}));
  if(key==='runningTasks')return items.filter(x=>x.kind==='task'&&!x.archived&&x.data?.status==='in_progress').map(x=>({id:x.id,kind:'任务',title:x.data?.title??x.id}));
  if(key==='waitingTasks')return items.filter(x=>x.kind==='task'&&!x.archived&&x.data?.status==='waiting').map(x=>({id:x.id,kind:'任务',title:x.data?.title??x.id}));
  return [];
 };
 const metricClick=e=>{const b=e.target.closest('[data-metric]');if(!b)return;onListGroup?.(groupRows(b.dataset.metric),b.querySelector('.label')?.textContent??'');};
 const metricsBox=metricsNode;if(metricsBox)metricsBox.addEventListener('click',metricClick);
 const eventClick=e=>{const b=e.target.closest('[data-event]');if(b)openEvent?.(b.dataset.event);},topicClick=e=>{const b=e.target.closest('[data-topic]');if(b)openTopic?.(b.dataset.topic);};
 timeline.addEventListener('click',eventClick);news.addEventListener('click',topicClick);
 return {dispose(){metricsBox?.removeEventListener('click',metricClick);timeline.removeEventListener('click',eventClick);news.removeEventListener('click',topicClick)}};
}
