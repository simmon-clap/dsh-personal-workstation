import {dayText} from './human-time.mjs';
import {escapeHtml as esc,ring} from './project-render.mjs';
import {projectModels} from './project-data.mjs';
import {refLabels} from './ref-labels.mjs';
import {validDate} from '../src/validation.mjs';

const PHASES=['接触','需求','方案','验证','复盘'];
const STATUS={todo:'待办',waiting:'等待中',in_progress:'进行中',done:'已完成',cancelled:'已取消'};
const ITEM_STATUS={todo:'待办',doing:'进行中',done:'已完成',blocked:'受阻'};
const today=()=>new Date().toISOString().slice(0,10);
const late=(date,done)=>Boolean(date)&&date<today()&&!done;

async function related(send,kind,projectId){
 const all=[];
 for(let offset=0;offset<10000;offset+=200){
  const {items=[]}=await send('list',{kind,projectId,limit:200,offset});
  all.push(...items.filter(x=>!x.archived&&x.kind===kind&&x.data.projectId===projectId));
  if(items.length<200)return all;
 }
 throw Error('关联记录超出读取范围');
}

/** 项目详情 = 项目管理面板：概览 / 阶段推进 / 计划与里程碑 / 任务 / 材料 / 交付项。
 *  以前这里只有计数和只读的阶段条，看不出"这个项目现在到哪、谁在做、做到什么程度、材料在哪"。 */
export async function populatedProjectHtml(item,send){
 const data=item.data;
 const [tasks,files,partner]=await Promise.all([
  related(send,'task',item.id),
  related(send,'artifact',item.id),
  data.partnerId?send('get',{id:data.partnerId}):Promise.resolve({item:null}),
 ]);
 const [p]=projectModels([item,...tasks,...files,...(partner.item?[partner.item]:[])]);
 const phases=PHASES,stageIndex=phases.indexOf(data.stage);
 const stage=stageIndex+1;
 const history=new Map((data.stageHistory??[]).filter(entry=>entry&&entry.stage).map(entry=>[entry.stage,entry.at]));
 const refs=refLabels(send);
 const ownerNames=await refs.resolve('person',[...tasks.map(task=>task.data.ownerId),data.ownerId??null].filter(Boolean));
 const deliverables=data.deliverables??[];
 const dated=deliverables.filter(entry=>validDate(entry.dueDate));
 const lateDeliverables=dated.filter(entry=>late(entry.dueDate,entry.done===true||entry.status==='done'));
 const lateTasks=tasks.filter(task=>late(task.data.dueDate,task.data.status==='done'||task.data.status==='cancelled'));

 // 2026-10-14：阶段条原来是**只读**的 span —— 想改阶段只能滚到弹窗底部点「编辑项目」再选下拉。
 // 现在每一格就是可点的按钮：点哪一格就是哪一格，立刻生效并可撤销（契约：自己的操作直接生效）。
 // 「推进到下一阶段」那个按钮保留（最常见的动作，一格点击反而更绕）。
 const phaseRail=phases.map((name,index)=>{
  const reached=stageIndex>=0&&index<=stageIndex;
  const at=history.get(name);
  const current=name===data.stage;
  return `<button type="button" class="phasechip${reached?' done':''}${current?' current':''}" data-phase="${esc(name)}" data-phase-set="${esc(name)}" aria-pressed="${current?'true':'false'}">${esc(name)}${at?`<small>${esc(String(at).slice(0,10))}</small>`:''}</button>`;
 }).join('');

 const undoneCount=deliverables.filter(entry=>!entry.done).length;
// 交付项可以标阶段（第 3 批）：这句说明必须如实——只有真的标了阶段才说"其中 M 项属于当前阶段"。
const stagedUndone=data.stage?deliverables.filter(entry=>!entry.done&&entry.stage===data.stage).length:0;
 const nextPhase=stageIndex>=0&&stageIndex<phases.length-1?phases[stageIndex+1]:null;
 const milestoneRows=deliverables.length?deliverables.map(entry=>{
  const done=entry.done===true||entry.status==='done';
  const isLate=late(entry.dueDate,done);
  // 交付项与任务的关系：任务可以挂交付项，这里如实显示支撑它的任务数与完成情况。
  const supporting=tasks.filter(task=>task.data.deliverableId===entry.id);
  const supportingDone=supporting.filter(task=>task.data.status==='done').length;
  const supportText=supporting.length?` · ${supporting.length} 个任务支撑（${supportingDone} 已完成）`:' · 暂无任务挂到它';
  return `<div class="managerow" data-deliverable="${esc(entry.id)}"><span class="chip" data-state="${done?'done':isLate?'late':'open'}">${done?'已完成':isLate?'已逾期':entry.dueDate?'已排期':'未排期'}</span><strong>${esc(entry.title)}</strong><small>${entry.dueDate?esc(dayText(entry.dueDate)):'没有日期'}${entry.ownerId?' · '+esc(ownerNames.get(entry.ownerId)??'负责人未知'):''}${entry.status?' · '+esc(ITEM_STATUS[entry.status]??entry.status):''}${supportText}</small></div>`;
 }).join(''):'<p class="notice">还没有交付项。交付项是"项目要交什么"，可在「编辑项目」里维护。</p>';

 const taskRows=tasks.length?tasks.map(task=>{
  const steps=task.data.steps??[],doneSteps=steps.filter(step=>step.done).length;
  const isLate=late(task.data.dueDate,task.data.status==='done');
  return `<button class="taskrow" data-task="${esc(task.id)}"><span class="symbol" style="width:29px;height:29px"><svg class="icon" aria-hidden="true"><use href="#i-${task.data.status==='done'?'task':'chip'}"/></svg></span><span><strong>${esc(task.data.title)}</strong><small>${esc(STATUS[task.data.status]??'状态未设置')}${task.data.ownerId?' · '+esc(ownerNames.get(task.data.ownerId)??'负责人未知'):' · 未指定负责人'}${task.data.dueDate?' · 截止 '+esc(task.data.dueDate)+(isLate?'（已逾期）':''):' · 无截止'}</small><span class="taskrail">${steps.map(step=>`<i class="${step.done?'done':''}"></i>`).join('')}</span></span><span style="text-align:right;color:var(--ws-muted);font-size:12px">${doneSteps}/${steps.length}<small style="display:block">${steps.length?Math.round(doneSteps/steps.length*100)+'% 步骤':'尚无步骤'}</small></span></button>`;
 }).join(''):'<p class="notice">还没有任务。任务可以直接建在这个项目下（会自动带上项目 ID）。</p>';

 const materialRows=files.length?files.map(file=>`<div class="managerow" data-material="${esc(file.id)}"><strong>${esc(file.data.title)}</strong><small>${esc(file.data.path??'未关联文件路径')}${file.data.fileVersion?' · 版本 '+esc(file.data.fileVersion):''}</small><button class="btn" data-material-open="${esc(file.id)}">打开</button><button class="btn" data-material-unlink="${esc(file.id)}">取消关联</button></div>`).join(''):'<p class="notice">还没有关联材料。可以关联已有资料，或直接为这个项目录入。</p>';

 // 优先级：与卡片、筛选、排序使用同一套取值，未设置就如实写"未设置"。
 const levelOf=value=>({high:'高',medium:'中',low:'低'})[value];
 const priority=data.importance||data.urgency
  ?`<strong>重要 ${data.importance?levelOf(data.importance):'未设置'} · 紧急 ${data.urgency?levelOf(data.urgency):'未设置'}</strong><small>用于默认排序与筛选</small>`
  :'<strong>优先级未设置</strong><small>在下面「重要程度 / 紧急程度」里点一下就能填；填了项目列表会默认按它排序</small>';
 const plan=validDate(data.startDate)||validDate(data.dueDate)
  ?`<strong>${esc(data.startDate??'未设置')} → ${esc(data.dueDate??'未设置')}</strong><small>计划区间${dated.length?` · ${dated.length} 个已排期交付项`:''}${lateDeliverables.length?` · ${lateDeliverables.length} 个已逾期`:''}</small>`
  :'<strong>计划日期未设置</strong><small>在下面「开始 / 截止」里点一下就能填；填了这里和路线图都会显示</small>';

 // 目标始终显示：项目管理面板的第一件事是"这个项目要达成什么"。
 // 目标：只读展示一处即可，**可就地改的那一份在底部**（A 报的"同一信息两处出现"）。
// 这里不再重复指路"去「编辑项目」里填" —— 那条六步路已经被就地编辑取代。
const goal=`<div class="proof" id="newprojectgoal">${esc(data.goal||'目标待补充：在下面「目标」里点一下就能写')}</div>`;
 return `${goal}<p>${esc(p.partner)} · 按交付项计算进度</p>
<div style="display:flex;align-items:center;gap:var(--ws-space-24);margin-top:var(--ws-space-16)">${ring(p.done,p.total,p.color)}<div><h3 style="margin:0">已完成 ${p.done} / ${p.total} 项交付</h3><p>剩余 ${p.total-p.done} 项 · ${p.block} 项等待</p></div></div>
<div class="detailmetrics"><div><b>${tasks.length}</b><small>关联任务</small></div><div><b>${files.length}</b><small>关联材料</small></div><div><b>阶段：${data.stage?esc(data.stage):'未记录'}</b><small>${stage?'第 '+stage+'/'+phases.length+' 步':'阶段未记录'}</small></div><div><b>${lateDeliverables.length+lateTasks.length}</b><small>逾期项</small></div></div>
<!-- 阶段条本身可点之后，原来那个蓝色「推进到下一阶段」按钮就是**同一件事的第二个控件**了
     （克制 + VI §6 同一控件全站唯一实现）。这里只留一句说明，动作交给下面的格子。 -->
<div class="sectionhead" data-section="stage"><h3>阶段推进</h3><span class="sectionactions"><small class="notice" style="margin:0">点任意一格就是那个阶段；往前直接生效，往回退会先问一句</small></span></div><div class="phase" data-phase-rail>${phaseRail}</div>
${undoneCount?`<p class="notice" data-undone="1">当前阶段还有 ${undoneCount} 项交付未完成${stagedUndone?`，其中 ${stagedUndone} 项属于当前阶段「${esc(data.stage)}」`:'（交付项还没标阶段，按项目整体统计）'}。</p>`:''}
<h3>优先级与计划</h3><div class="managerow" data-priority>${priority}</div><div class="managerow" data-plan>${plan}</div>${milestoneRows}
<div class="sectionhead" data-section="tasks"><h3>任务 · ${tasks.length}</h3><span class="sectionactions"><button class="btn" data-newtask="1">在这个项目下新建任务</button></span></div>${taskRows}
<div class="sectionhead" data-section="materials"><h3>材料 · ${files.length}</h3><span class="sectionactions"><button class="btn" data-linkmaterial="1">关联已有材料</button><button class="btn" id="newprojectintake" data-intake="1">为该项目录入资料</button></span></div>${materialRows}
<h3>交付构成</h3>${p.total?`<div class="meter"><span>已完成</span><i><em style="width:${p.done/p.total*100}%;background:${p.color}"></em></i><b>${p.done}</b></div><div class="meter"><span>未完成</span><i><em style="width:${(p.total-p.done)/p.total*100}%;background:var(--ws-line)"></em></i><b>${p.total-p.done}</b></div>`:'<p class="notice" data-empty-deliveries="1">还没有交付项，先加交付项再看完成比例。</p>'}
`;
}

export {PHASES};
