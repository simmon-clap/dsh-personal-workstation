// Data boundary for the V7 renderer. No demo records, inferred stage or execution status.
const LEVEL={high:3,medium:2,low:1};
/** 重要×紧急的排序分：重要优先，其次紧急；都没填就是 0（排到最后，且不假装有优先级）。 */
function priorityScore(data){const importance=LEVEL[data.importance]??0,urgency=LEVEL[data.urgency]??0;return importance*10+urgency;}
export const priorityLabels=value=>({high:'高',medium:'中',low:'低'})[value]??'未设置';
/** 默认排序：优先级分高者在前；同分按截止日期近者在前，再按名称。 */
export function sortByPriority(models){
 return [...models].sort((left,right)=>{
  if(right.priorityScore!==left.priorityScore)return right.priorityScore-left.priorityScore;
  const leftDue=left.dueDate??'9999-12-31',rightDue=right.dueDate??'9999-12-31';
  if(leftDue!==rightDue)return leftDue<rightDue?-1:1;
  return String(left.name).localeCompare(String(right.name),'zh');
 });
}
export function projectModels(items){
 const live=items.filter(x=>!x.archived),byId=new Map(live.map(x=>[x.id,x]));
 // VI §2 / §14 V5：knowledge 紫只表达知识 / 记忆 / AI 判断，不得当项目色。
 // 第 3 槽是**数据标识**（用来区分不同项目），所以用 data-palette 里登记的数据紫；
 // 语义色被数据借用之后，它原本那个含义就废了。
 const palette=[['var(--ws-action)','var(--ws-action-soft)','chip'],['var(--ws-success)','var(--ws-success-soft)','cloud'],['var(--ws-data-partner-3)','var(--ws-data-partner-3-soft)','link'],['var(--ws-warning)','var(--ws-warning-soft)','project']];
 return live.filter(x=>x.kind==='project').map((p,index)=>{
  const data=p.data,deliverables=data.deliverables??[],tasks=live.filter(x=>x.kind==='task'&&x.data.projectId===p.id),partner=byId.get(data.partnerId);
  const [color,bg,icon]=palette[index%palette.length];
  return {id:p.id,revision:p.revision,name:data.title,// 原型卡片把组织名与其描述（领域）拼在一起显示；只显示名称会丢掉业务含义。
 partner:partner?.kind==='organization'?(partner.data.description?partner.data.title+' · '+partner.data.description:partner.data.title):'合作方未设置',done:deliverables.filter(d=>d.done===true).length,total:deliverables.length,progressLabel:deliverables.length?`${deliverables.filter(d=>d.done===true).length}/${deliverables.length}`:'尚未设置',docs:live.filter(x=>x.kind==='artifact'&&x.data.projectId===p.id).length,tasks:tasks.length,block:tasks.filter(t=>t.data.status==='waiting').length,stage:null,stageLabel:data.stage||'阶段未设置',startDate:data.startDate??null,dueDate:data.dueDate??null,color,bg,icon,goal:data.goal??'',deliverables:deliverables.map(x=>({...x})),
 // 重要度/紧急度：用户要求"默认按紧急程度与重要程度排序"。未设置的一律排在已设置之后，
 // 不用默认值假装用户表达过优先级。
 importance:data.importance??'',urgency:data.urgency??'',
 partnerId:data.partnerId??'',ownerId:data.ownerId??'',folder:data.folder??'',
 // 当前阶段的进入时间：取 stageHistory 里该阶段最后一条（没有就留空，不猜）
 stageEnteredAt:(()=>{const list=(data.stageHistory??[]).filter(entry=>entry&&entry.stage===data.stage);const last=list.at(-1);return last?.at?String(last.at).slice(0,10):'';})(),
 priorityScore:priorityScore(data),
 lateCount:deliverables.filter(d=>d.done!==true&&typeof d.dueDate==='string'&&d.dueDate<new Date().toISOString().slice(0,10)).length,
 hasDates:Boolean(data.startDate)||Boolean(data.dueDate)};
 });
}
export async function readProjectModels(send){const items=[],seen=new Set();let offset=0;for(;;){const result=await send('list',{limit:200,offset,includeArchived:false});if(!Array.isArray(result.items))throw Error('项目数据响应无效');for(const item of result.items){if(seen.has(item.id))throw Error('读取期间数据变化，请刷新重试');seen.add(item.id);items.push(item);}if(result.items.length<200)break;offset+=200;if(offset>=10000)throw Error('数据超过当前读取范围，不能显示不完整统计');}return projectModels(items);}
