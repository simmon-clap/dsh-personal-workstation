import {escapeHtml as esc,ring} from './project-render.mjs';
import {showEmpty} from './empty-state.mjs';
import {taskModel,taskRow} from './task-render.mjs';
import {cardOpen,cardClose} from './card.mjs';
import {taskStatusLabels} from './status-vocab.mjs';
export function taskModels(items){const live=items.filter(x=>!x.archived),byId=new Map(live.map(x=>[x.id,x]));return live.filter(x=>x.kind==='task').map(x=>{const d=x.data;const owner=byId.get(d.ownerId);return {...taskModel(x,live.filter(p=>p.kind==='project').map(p=>({id:p.id,name:p.data.title,deliverables:p.data.deliverables??[]}))),ownerName:owner?.kind==='person'?String(owner.data?.title??''):'',businessStatus:d.status,executionStatus:x.execution?.status??null,dependencies:(d.dependsOn??[]).map(id=>byId.get(id)?.data.title||id),input:d.inputScope||d.description||''};});}
export {taskRow};
// ── 负责人筛选（第 3 批 P1-1，方案 A）────────────────────────────────────────────
// 选项只来自**真实存在的 person 记录**：items 是当前工作区的活跃对象全集（readWorkspaceItems 分页读全），
// 所以"查不到人"就等于"已归档或不存在的记录"。界面**不提供"我"**：插件没有"当前操作者 → person 记录"
// 的映射（浏览器侧 actor 是 operator:<宿主连接 id>），不许用最近操作者 id 猜一个负责人出来。
export const NO_OWNER='__none__';
/** id → 名称；没有名称的记录退 id 并标注，不编名字。 */
export function liveOwnerNames(items){return new Map(items.filter(x=>x.kind==='person'&&!x.archived).map(x=>[x.id,x.data?.title||x.id+'（名称未记录）']));}
/** 未指定负责人 = ownerId 缺失，或指向已归档/不存在的记录。 */
export function taskOwnerKey(task,live){return task.ownerId&&live.has(task.ownerId)?task.ownerId:NO_OWNER;}
/** 下拉选项：全部 / 未指定 / 真实出现过的负责人（按名称排序）。 */
export function ownerFilterOptions(tasks,live){
 const used=[...new Set(tasks.map(task=>taskOwnerKey(task,live)).filter(key=>key!==NO_OWNER))];
 used.sort((a,b)=>live.get(a).localeCompare(live.get(b),'zh'));
 return [['','全部负责人'],[NO_OWNER,'未指定负责人'],...used.map(id=>[id,live.get(id)])];
}
export function applyTaskOwnerFilter(tasks,owner,live){return owner===''?tasks:tasks.filter(task=>taskOwnerKey(task,live)===owner);}
import {selectHtml,wireSelects} from './vi-select.mjs';
import {filterBarHtml,wireFilterBar} from './project-view.mjs';
export function mountTaskViews(document,items,onOpen,{onCreate}={}){const tasks=taskModels(items),live=liveOwnerNames(items);let mode='board',target='all',owner='';const body=document.querySelector('#tasksbody'),tabs=document.querySelector('#tasktabs'),shell=document.querySelector('#taskfilters');
 const metric=(label,val)=>`<div class="metric"><div><p>${label}</p><b>${val}</b></div></div>`;
 // 执行位置筛选原来是一排常驻片（全部 | Mini | 本机）加一个负责人下拉，连「筛选」按钮都没有 ——
 // 三处筛选三个长相（审计 P2 #19）。现在按全站唯一的「筛选」控件重排：工具栏只留一个按钮，
 // 片与下拉都收进面板，生效条数写在按钮上。容器 id 仍是 #taskfilters：
 // 逐控件审计按该容器判定"是否接线"，既有测试也按 `#taskfilters [data-target=…]` 取控件。
 const taskChips=shell?[...shell.querySelectorAll('[data-target]')].map(node=>({value:node.dataset.target,label:node.textContent.trim()})):[];
 const barHost=document.createElement('div');
 barHost.innerHTML=filterBarHtml({id:'taskfilters',toggleId:'taskfiltertoggle',chips:taskChips,chipAttribute:'data-target',chipValue:target,
  fields:[selectHtml({name:'taskowner',attribute:'data-taskowner',options:ownerFilterOptions(tasks,live),placeholder:'全部负责人',id:'taskownerselect'})]});
 const [toggle,filters]=[...barHost.children];
 // 负责人筛选用**全站唯一的 VI 选择控件**（门禁 4）：这里原来是手搓的原生下拉，全站只有它一个，
 // 视觉不是「纸上秩序」那一套、四态也不齐；改成 selectHtml 之后取值仍从 hidden input 读。
 filters.querySelector('#taskownerselect [data-viselect-button]')?.setAttribute('aria-label','负责人筛选');
 // id 放在取值口上：#taskowner 仍是「那个下拉的取值处」，`.value` 与 change 口径与原生一致。
 filters.querySelector('[data-taskowner]').id='taskowner';
 // 上一轮挂上去的按钮要先摘掉，否则工具栏会攒出第二个「筛选」。
 document.querySelector('#taskfiltertoggle')?.remove();
 if(shell)shell.replaceWith(toggle,filters);else tabs?.after(toggle,filters);
 wireSelects(filters,{document});
 // 对外仍暴露 ownerSelect：VI 下拉里那个 hidden input 就是取值口（.value 口径与原生一致），
 // 现有调用方与测试不用改。
 const ownerSelect=filters.querySelector('#taskowner');
 // 执行位置与负责人各算一条：默认值（全部 / 全部负责人）不算，免得按钮上写着"筛了"其实没筛。
 const bar=wireFilterBar(filters.parentElement,{id:'taskfilters',toggleId:'taskfiltertoggle',state:{get target(){return target},get owner(){return owner}},counted:['target','owner'],defaults:{target:'all',owner:''},chips:{attribute:'data-target',key:'target'}});
 const ownerLabel=()=>owner===''?'':owner===NO_OWNER?'未指定负责人':live.get(owner);
 function render(){const ts=applyTaskOwnerFilter(tasks.filter(t=>target==='all'||t.target===target),owner,live);for(const b of tabs.querySelectorAll('button')){b.classList.toggle('active',b.dataset.tmode===mode);b.setAttribute('aria-pressed',String(b.dataset.tmode===mode));}
 // 筛选片的选中态与按钮上的条数由共用控件统一维护（同一个口径，不再各页各写一遍）。
 bar?.sync();
 // 指标：只显示**有内容的**；待办第一（真实数据 5 条全是待办，旧版把它藏起来、四个 0 占满首屏）。
 const taskMetrics=document.querySelector('#taskmetrics');taskMetrics.dataset.groupcount='1';taskMetrics.closest('.view')?.setAttribute('data-metricsscope','1');
 const runningLabel=taskStatusLabels.in_progress;
 const counts=[[taskStatusLabels.todo,ts.filter(t=>t.state===taskStatusLabels.todo).length],[runningLabel,ts.filter(t=>t.state===runningLabel).length],[taskStatusLabels.waiting,ts.filter(t=>t.state===taskStatusLabels.waiting).length],[taskStatusLabels.done,ts.filter(t=>t.state===taskStatusLabels.done).length]];
 const totalSteps=ts.reduce((s,t)=>s+t.total,0);
 const shownMetrics=counts.filter(([,n])=>n>0);
 if(totalSteps>0)shownMetrics.push(['步骤完成',ts.reduce((s,t)=>s+t.done,0)+'/'+totalSteps]);
 taskMetrics.style.display=shownMetrics.length?'':'none';
 taskMetrics.innerHTML=shownMetrics.map(([label,value])=>metric(label,value)).join('')
  +(shownMetrics.length&&(bar?.count?.()??0)>0?'<small class="metricsnote" data-metricsfiltered="1">按当前筛选计算</small>':'');
 if(mode==='board'&&ts.length){
  // 列顺序固定为「待办→等待中→运行中→已完成→其它真实状态」；**只渲染有卡片的列**，
  // 空列折叠成看板下方一行灰字（46 号审计：待办被写死在第 4 列、前三列 75% 是空的）。
  const ORDER=[taskStatusLabels.todo,taskStatusLabels.waiting,taskStatusLabels.in_progress,taskStatusLabels.done];
  const extras=[...new Set(ts.map(t=>t.state))].filter(s=>!ORDER.includes(s));
  const stateOrder=[...ORDER,...extras];
  const filled=stateOrder.filter(s=>ts.some(t=>t.state===s));
  const emptyStates=stateOrder.filter(s=>!ts.some(t=>t.state===s));
  // 只有一个有内容的分组时，让这一列宽一些：卡片标题不再挤成两三行（W2-1 字阶放大后 5 张卡需仍在首屏）。
  body.innerHTML='<div class="kanban'+(filled.length===1?' single':'')+'">'+filled.map(s=>`<div class="column" data-groupcount="1"><h3>${s} · ${ts.filter(t=>t.state===s).length}</h3>${ts.filter(t=>t.state===s).map(t=>`${cardOpen({task:t.id})}<span class="taskcontext">${esc(t.projectName)} / ${esc(t.target)}</span><h3 style="color:var(--ws-ink);margin:var(--ws-space-4) 0">${esc(t.name)}</h3>${t.total?ring(t.done,t.total):''}<p>${t.total?`${t.done} / ${t.total} 步骤 · ${Math.round(t.done/t.total*100)}%`:'尚无步骤'}</p>${t.ownerName?`<p class="tagline" data-owner="1">负责人 ${esc(t.ownerName)}</p>`:''}${t.state===taskStatusLabels.waiting?`<p class="tagline" data-blocked="1">等待原因：${esc(t.blockedReason||'原因未记录')}</p>`:''}${t.deliverableName?`<p class="tagline" data-deliverable="1">支撑交付项：${esc(t.deliverableName)}</p>`:''}${t.dueDate?`<p class="tagline" data-due="1">截止 ${esc(t.dueDate)}</p>`:''}<div class="taskrail">${t.steps.map(s=>`<i class="${s.done?'done':''}"></i>`).join('')}</div>`+cardClose()).join('')}</div>`).join('')+'</div>'
   +(emptyStates.length?`<p class="kanbancollapsed" data-emptycolumns="${emptyStates.map(esc).join(',')}">${emptyStates.map(esc).join(' · ')}：暂无任务</p>`:'');
 }
 else body.innerHTML='<div class="surface pad"><h2>任务依赖 · 当前筛选</h2><p>节点可点击；每个任务只展示其已声明的输入条件。</p>'+ts.map(t=>`<div style="display:grid;grid-template-columns:1fr 30px 1.6fr;align-items:center;margin:var(--ws-space-16) 0"><span class="chip">${esc(t.dependencies.length?t.dependencies.join('、'):'未声明前置任务')}</span><span style="text-align:center;color:var(--ws-line)">→</span><div>${taskRow(t)}</div></div>`).join('')+'</div>';
 // VI 空态：没有任务时给出说明与下一步，而不是一句“暂无”。筛空时要说明是哪个筛选造成的。
 if(!ts.length)showEmpty(body,{illustration:'waiting',title:owner!==''?'该负责人暂无任务':target==='all'?'还没有任务':'该执行位置暂无任务',description:owner!==''?'当前「负责人：'+ownerLabel()+'」筛选下没有任务；切回「全部负责人」，或给任务指定负责人后再看。':target==='all'?'在项目里添加任务后，这里会按业务状态分组显示。':'切换筛选或把任务分配到该执行位置后再查看。',
  action:(owner!==''||target!=='all')
   ?{label:'清除筛选',run:()=>{owner='';target='all';ownerSelect.value='';render()}}
   :(onCreate?{label:'新建任务',run:onCreate}:undefined)});
 }
 // VI 选择控件里的 hidden input 会派发 change 事件，取值口径与原生一致。
 ownerSelect.onchange=()=>{owner=ownerSelect.value;render();};
 const tabClick=e=>{const b=e.target.closest('[data-tmode]');if(b){mode=b.dataset.tmode;render();}},filterClick=e=>{const b=e.target.closest('[data-target]');if(b){target=b.dataset.target;render();}},open=e=>{const b=e.target.closest('[data-task]');if(b)onOpen(b.dataset.task);};tabs.addEventListener('click',tabClick);filters.addEventListener('click',filterClick);body.addEventListener('click',open);const mini=document.querySelector('#taskmini');mini.innerHTML=tasks.slice(0,4).map(taskRow).join('');mini.addEventListener('click',open);render();return {tasks,ownerSelect,dispose(){tabs.removeEventListener('click',tabClick);filters.removeEventListener('click',filterClick);body.removeEventListener('click',open);mini.removeEventListener('click',open);ownerSelect?.closest('#taskownerselect')?.remove()}};
}
