import {whenText, dayText} from './human-time.mjs';
import {taskModel} from './task-render.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {sharedModal} from './modal.mjs';
import {refLabels} from './ref-labels.mjs';
import {inlineField, appendInlineFields} from './inline-edit.mjs';

export function taskDetailHtml(item,project){
 const t=taskModel(item,project?[{id:project.id,name:project.data.title}]:[]),d=item.data;
 const execution=({queued:'排队中',running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'})[item.execution?.status]||item.execution?.status||'尚无执行记录';
 return `<p>${esc(t.projectName)} · ${esc(t.target)} · ${esc(t.state)}</p><div class="detailmetrics"><div><b>${t.total?Math.round(t.done/t.total*100)+'%':'—'}</b><small>按已完成步骤计算</small></div><div><b>${t.done}/${t.total}</b><small>步骤完成</small></div><div><b>${esc(t.target)}</b><small>执行位置</small></div></div><h3>执行展开</h3>${t.steps.map((s,i)=>`<div class="evidence"><span style="color:${s.done===true?'var(--ws-success)':'var(--ws-muted)'}">${s.done===true?'✓':'○'} &nbsp; ${i+1}. ${esc(s.title||'未命名步骤')}</span><span style="color:var(--ws-muted)">${s.done===true?'已完成':'未完成'}</span></div>`).join('')||'<p>尚无步骤</p>'}<h3>输入与产物</h3><p>输入：${esc(d.inputScope||d.description||'未指定输入')}</p><p>产物：${esc(d.expectedOutput||'未指定预期输出')}</p>${project?`<button class="btn" data-project="${esc(project.id)}" style="margin-top:16px">返回所属项目</button>`:''}<p class="notice">DSH 执行：${esc(execution)}。</p>`;
}

export function createTaskDetail(document,send,{openProject,onEdit,openCanvas,onLinkMaterial,onInlineChange=null,notify=()=>{},generatedView=null,onOpenSubject=null}){
 // 与「编辑任务」用同一套取值，不另立一套（VI §6 同一控件唯一实现）。
 const statusOptions=[['todo','待办'],['waiting','等待'],['in_progress','进行中'],['done','已完成'],['cancelled','已取消']];
 const targetOptions=[['local','当前 DSH 主机'],['mini','Mini']];
 const modal=sharedModal(document);let token;
 const executionNames={reserved:'已预留',running:'运行中',cancelling:'取消中',completed:'执行结束',cancelled:'已取消',failed:'失败',incomplete:'输出未完成',refused:'已拒绝'};
 async function history(item,offset=0){
  const request=token=modal.begin();if(request===null)return;
  const result=await send('execution_history',{taskId:item.id,limit:20,offset});if(!modal.current(request))return;
  const rows=(result.items??[]).map(run=>`<section class="evidence"><h3>${esc(executionNames[run.status]||run.status)}</h3><small>任务版本 ${esc(String(run.taskRevision))} · ${esc(run.createdAt||'时间未记录')}</small><p>执行标识：${esc(run.id)}</p>${run.sessionId?`<p>子会话：${esc(run.sessionId)}</p>`:''}${run.text?`<pre style="white-space:pre-wrap">${esc(run.text)}</pre>`:''}${run.diagnostic?`<p>${esc(run.diagnostic)}</p>`:''}</section>`).join('');
  // 没有记录时，若宿主明确报告执行器未接入，就把原因说清楚——而不是让用户以为"跑过了但没记录"。
  let connectionNote='';
  if(!rows){
   try{const status=await send('runtime_status');if(status?.capabilities?.execution===false)connectionNote='执行器未接入：现在不会产生新的运行记录。';}
   catch{connectionNote='';}
  }
  const html=`<p class="notice">执行状态与业务完成状态独立；本窗口只读取历史。${connectionNote?'<br>'+esc(connectionNote):''}</p>${rows||'<p>暂无执行记录；这不代表业务任务已完成。</p>'}<div class="modalactions">${offset>0?'<button class="btn" id="execprev">上一页</button>':''}${result.nextOffset!==null&&result.nextOffset!==undefined?'<button class="btn" id="execnext">下一页</button>':''}<button class="btn" id="execback">返回任务</button></div>`;
  if(!modal.present(request,{title:'任务执行历史',type:'执行历史',html}))return;
  const wire=(selector,handler)=>{const node=document.querySelector(selector);if(node)node.onclick=handler};
  wire('#execprev',()=>history(item,Math.max(0,offset-20)));wire('#execnext',()=>history(item,result.nextOffset));wire('#execback',()=>open(item.id));
 }
 async function open(id){
  const request=token=modal.begin();if(request===null)return;const {item}=await send('get',{id});if(!modal.current(request))return;
  if(!item||item.kind!=='task'||item.archived)throw Error('任务已归档或不可用，请刷新');
  let project;if(item.data.projectId){const result=await send('get',{id:item.data.projectId});if(!modal.current(request))return;project=result.item;if(!project||project.kind!=='project'||project.archived)throw Error('所属项目不可用，请刷新');}
  // 有上级就提供返回：任务详情 → 所属项目详情（没有所属项目时返回等同于关闭）。
  if(!modal.present(request,{title:item.data.title,type:'任务',html:taskDetailHtml(item,project),
   onBack:project?.id?()=>openProject(project.id):undefined}))return;
  const body=document.querySelector('#detailbody');
  const link=body.querySelector('[data-project]');if(link)link.onclick=()=>openProject(project.id);
  // 负责人与依赖：字段本来就存在，这里把真实名称显示出来（查不到就如实说明）。
  const refs=refLabels(send);
  const refLine=document.createElement('p');refLine.dataset.refsLine='1';
  const actions=document.createElement('div');actions.className='modalactions';
   const make=(label,cls,run,id)=>{const button=document.createElement('button');button.className='btn'+(cls?' '+cls:'');button.textContent=label;if(id)button.id=id;button.onclick=run;actions.append(button);return button};
   // 执行历史与"执行器是否开启"是两件事：历史记录可以在执行器关闭时依然存在，
 // 因此这里**不禁用**按钮；是否接入由历史窗口如实说明（见 history()）。
 make('查看执行历史','',()=>history(item),'taskhistory');make('在画布中查看关联','',()=>openCanvas?.(item.id),'taskcanvas');if(onLinkMaterial)make('关联已有材料','',()=>onLinkMaterial(item),'tasklinkmaterial');make('编辑任务','primary',()=>onEdit?.('task',item));
  body.append(actions);
  // ── 生成视图（27 号方案 G3）：任务详情里的「阻塞说明」入口 ──
  // 单一区块，不新增页面/入口；回答"卡在哪、等谁、下一步做什么"。
  // 预览不落库；保存（存为判断/简报）走 view_save → 既有收件箱确认。
  if(generatedView&&typeof generatedView.block==='function'){
   const viewBlock=generatedView.block({
    subjectId:item.id,
    subjectTitle:item.data?.title??'这条任务',
    subjectKind:'任务',
    heading:'AI 分析',
    summary:'看这条任务卡在哪、在等谁、下一步做什么；只是预览，不保存，关闭即弃。',
    templates:[{id:'blocker',label:'生成阻塞说明',params:{}}],
    onOpenSubject:id=>{if(id!==item.id)onOpenSubject?.(id)},
    emptyActions:onEdit?{blocker:{label:'去补等待原因',run:()=>onEdit('task',item)}}:undefined,
   });
   if(actions.isConnected)actions.before(viewBlock.element);
   else body.append(viewBlock.element);
  }
  // 负责人/依赖/截止/关联材料这一行必须插在动作区之前：原先在 actions 还没进 DOM 时就 before(refLine)，
  // 按规范那是空操作——这一行（以及 0.8.0 承诺的"详情显示负责人与依赖"）实际从未出现。现在先挂 actions 再插。
  // W2-7：决定字段（负责人/业务状态/截止/执行端）放到弹窗最上面 —— 手机 390 首屏就能看到，
  // 不用先滚过执行步骤与输入产物（46 §1.2 的「看→判断→决定」在首屏）。
  body.prepend(refLine);
  // 异步取真实名称后填这一行（不阻塞弹窗打开）。
  // 2026-10-15 用户拍板（「项目和任务在直接单击可编辑上应该是一样的」）：
  // 这里原来是一行**纯文本**，点不动，改任何一项都要开「编辑任务」。现在各字段就地可改：
  // 点一下 → 就地编辑 → 立刻生效 + 左下可撤销（契约②）。与项目详情用**同一个**控件（VI §6 同一控件唯一实现）。
  void (async()=>{
   const ownerOptions=[['','未设置'],...((await send('list',{kind:'person',limit:200}).catch(()=>({items:[]}))).items??[]).filter(x=>!x.archived).map(x=>[x.id,x.data?.title??x.id])];
   if(!modal.current(request)||!refLine.isConnected)return;
   const labelOf=(list,value,fallback)=>list.find(([key])=>String(key)===String(value??''))?.[1]??fallback;
   const commit=(field,label)=>async next=>{await onInlineChange?.(item,{[field]:next});notify(label+'已改')};
   const box=document.createElement('div');box.className='inlinefields';
   appendInlineFields(box,[
    inlineField(document,{label:'负责人',value:item.data.ownerId??'',display:labelOf(ownerOptions,item.data.ownerId,'未设置'),options:ownerOptions,onCommit:commit('ownerId','负责人'),notify}),
    inlineField(document,{label:'业务状态',value:item.data.status??'',display:labelOf(statusOptions,item.data.status,'未设置'),options:statusOptions,onCommit:commit('status','业务状态'),notify}),
    inlineField(document,{label:'截止',value:item.data.dueDate??'',display:item.data.dueDate?whenText(item.data.dueDate):'未设置',type:'date',format:dayText,onCommit:commit('dueDate','截止日期'),notify}),
    inlineField(document,{label:'执行端',value:item.data.executionTarget??'local',display:labelOf(targetOptions,item.data.executionTarget??'local','当前 DSH 主机'),options:targetOptions,onCommit:commit('executionTarget','执行端'),notify}),
    inlineField(document,{label:'预期成果',value:item.data.expectedOutput??'',display:item.data.expectedOutput||'未设置',onCommit:commit('expectedOutput','预期成果'),notify}),
    // 等待原因只在"等待中"或已经填了的时候才出现 —— 不相关的字段不占版面（信息相关性）。
    ...(item.data.status==='waiting'||item.data.blockedReason
      ?[inlineField(document,{label:'等待原因',value:item.data.blockedReason??'',display:item.data.blockedReason||'原因未记录',onCommit:commit('blockedReason','等待原因'),notify})]
      :[]),
   ]);
   refLine.append(box);
   // 「执行端」这个下拉能被改，但**执行器根本没接通** —— 不说清楚，选了 Mini 会以为真的在 Mini 上跑
   // （《开发规划与约束》约束三「未接入不伪造」；04 把任务执行器列在"未接通"里）。
   // 字段本身仍有意义（记录意向），所以留着，但旁边必须写明它现在只是个意向。
   try{
    const status=await send('runtime_status');
    if(status?.capabilities?.execution===false&&modal.current(request)&&refLine.isConnected){
     const note=document.createElement('p');
     note.className='notice';note.style.margin='0';
     note.textContent='执行器未接入：执行端只记录意向，现在不会真的在 Mini 或本机上跑。';
     refLine.append(note);
    }
   }catch{/* 读不到状态就不加这句，不编造 */}
   // 依赖与材料是**关系**，不是简单字段：如实显示，改它们走各自的动作（不在这里做假的可编辑）。
   const extra=[];
   const depends=await refs.line('task',item.data.dependsOn,'依赖任务');
   if(depends)extra.push(depends);
   try{
    const materials=(await send('list',{kind:'artifact',limit:500})).items.filter(entry=>!entry.archived&&Array.isArray(entry.data?.taskIds)&&entry.data.taskIds.includes(item.id));
    if(!modal.current(request))return;
    extra.push(materials.length?('关联材料：'+materials.length+' 份'):'关联材料：暂无（可用「关联已有材料」添加）');
   }catch{extra.push('关联材料：读不到（不影响任务本身）')}
   if(extra.length&&refLine.isConnected){const note=document.createElement('p');note.className='notice';note.style.margin='0';note.textContent=extra.join(' · ');refLine.append(note)}
  })();
  return item;
 }
 return {open,close:modal.close,dispose(){modal.invalidate(token)}};
}
