import {validateViewDefinition} from './view-spec.mjs';
const common=['title','description','tags','projectId','sourceRefs'];
const fields={project:['goal','partnerId','ownerId','stage','startDate','dueDate','deliverables','folder','stageHistory','importance','urgency','roleTemplate','participants','organizationId'],task:['ownerId','dueDate','status','steps','dependsOn','executionTarget','expectedOutput','deliverableId','blockedReason'],organization:['website','contactId','note','defaultRole'],person:['organizationId','email','note'],topic:['content'],artifact:['path','fileGrantId','mime','content','fileVersion','knowledgeBaseId','knowledgeDocId','knowledgeUpdatedAt','taskIds'],event:['startDate','endDate','timezone','location','attendees','eventType','externalSource','externalUid','externalSyncedAt','externalFingerprint'],relation:['from','to','status','evidence','reason','basis'],layout:['positions','viewport','groups','roleColors','roleShapes','order'],proposal:['status','content'],memoryRef:['provider','reference','content','verification'],brief:['content','source','sourceUrl','publishedAt','fetchedAt','linkStatus','uncertainty'],judgment:['evidence','uncertainty','validFrom','reviewBy','status','overturnedBy','share','origin'],view:['template','subject','params','dataRefs','basis','generatedAt','origin','state','actions','savedAs','analysis']};
function invalid(message){const e=new Error(message);e.code='INVALID';throw e;}
export function validDate(value){
 const m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
 if(!m)return false;const y=+m[1],mo=+m[2],d=+m[3];const leap=y%4===0&&(y%100!==0||y%400===0);const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(mo<1||mo>12||d<1||d>days[mo-1])return false;
 if(m[4]!==undefined){if(+m[4]>23||+m[5]>59||+(m[6]??0)>59)return false;if(m[7]!=='Z'){const [h,min]=m[7].slice(1).split(':').map(Number);if(h>14||min>59||(h===14&&min!==0))return false;}}
 return Number.isFinite(Date.parse(value));
}
/** 本地时间 → 带本机时区偏移的时间（校验要求带时区；界面上的时间都是本地时间）。
 *  接受 `YYYY-MM-DD HH:MM`、`YYYY-MM-DDTHH:MM`、带秒、以及已带时区的值（原样返回）；日期原样返回。 */
export function toZonedDateTime(value){
 const text=String(value??'').trim();
 if(!text)return text;
 if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;
 if(/(?:Z|[+-]\d{2}:\d{2})$/.test(text))return text.replace(' ','T');
 const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
 if(!match)return text;
 const [,date,hh,mm,ss]=match;
 const offset=-new Date().getTimezoneOffset();
 const sign=offset>=0?'+':'-';
 const abs=Math.abs(offset);
 const zone=sign+String(Math.floor(abs/60)).padStart(2,'0')+':'+String(abs%60).padStart(2,'0');
 return `${date}T${hh}:${mm}:${ss??'00'}${zone}`;
}
export function validateDependencies(entities){
 const tasks=new Map([...entities].filter(e=>!e.archived&&e.kind==='task').map(e=>[e.id,e.data.dependsOn??[]]));
 const indegree=new Map([...tasks.keys()].map(id=>[id,0])),children=new Map();
 for(const [id,deps]of tasks){if(new Set(deps).size!==deps.length)invalid('任务依赖重复');for(const dep of deps){indegree.set(id,indegree.get(id)+1);if(!children.has(dep))children.set(dep,[]);children.get(dep).push(id);}}
 const queue=[...indegree].filter(([,n])=>n===0).map(([id])=>id);let count=0;for(let i=0;i<queue.length;i++){count++;for(const id of children.get(queue[i])??[]){indegree.set(id,indegree.get(id)-1);if(!indegree.get(id))queue.push(id);}}if(count!==tasks.size)invalid('任务依赖形成循环');
}
export function validateData(kind,data){
 if(!fields[kind]||!data||typeof data!=='object'||Array.isArray(data))invalid('对象类型或数据无效');
 const allowed=new Set([...common,...fields[kind]]);
 for(const key of Object.keys(data))if(!allowed.has(key))invalid('未知或受保护字段：'+key);
 for(const key of ['title','description','projectId','goal','partnerId','ownerId','stage','startDate','dueDate','expectedOutput','website','organizationId','email','contactId','note','content','path','fileGrantId','mime','fileVersion','knowledgeBaseId','knowledgeDocId','knowledgeUpdatedAt','endDate','timezone','location','eventType','from','to','status','reason','provider','reference','executionTarget','blockedReason'])if(key in data&&(typeof data[key]!=='string'||data[key].length>500000))invalid(key+'必须为文本');
 // 材料与任务是**多对多**（一份会议纪要常支撑多个任务）：taskIds 与其它引用数组同一套规则，
 // 条目必须是非空文本；指向的任务是否存在、是否归档由 store 在提交时按引用校验硬拦。
 for(const key of ['tags','sourceRefs','attendees','dependsOn','taskIds'])if(key in data&&(!Array.isArray(data[key])||data[key].length>1000||data[key].some(v=>typeof v!=='string'||!v.trim())))invalid(key+'必须为非空文本数组');
 for(const key of ['startDate','endDate','dueDate'])if(data[key]&&!validDate(data[key]))invalid(key+'必须为日期或带时区的时间');
 if(data.startDate&&data.endDate&&Date.parse(data.startDate)>Date.parse(data.endDate))invalid('结束时间早于开始时间');
 if(kind==='project'&&data.startDate&&data.dueDate&&Date.parse(data.startDate)>Date.parse(data.dueDate))invalid('项目截止时间早于开始时间');
  if(kind==='event'&&data.startDate&&data.endDate){const allDay=data.startDate.length===10;if(allDay!==(data.endDate.length===10))invalid('开始与结束必须同为日期或具体时间');if(!allDay&&Date.parse(data.startDate)===Date.parse(data.endDate))invalid('定时日程结束必须晚于开始');}
  if(kind==='task'&&data.status&&!['todo','waiting','in_progress','done','cancelled'].includes(data.status))invalid('无效业务任务状态');
 for(const key of ['steps','deliverables'])if(key in data){if(!Array.isArray(data[key])||data[key].length>1000)invalid(key+'必须为数组');const ids=new Set();for(const item of data[key]){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['id','title','done','dueDate','ownerId','status','stage'].includes(k))||typeof item.id!=='string'||!item.id||typeof item.title!=='string'||!item.title.trim()||typeof item.done!=='boolean'||ids.has(item.id)
   ||(item.dueDate!==undefined&&(typeof item.dueDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)))
   ||(item.ownerId!==undefined&&(typeof item.ownerId!=='string'||!item.ownerId.trim()))
   ||(item.status!==undefined&&!['todo','doing','done','blocked'].includes(item.status))
   ||(item.stage!==undefined&&(typeof item.stage!=='string'||!['','接触','需求','方案','验证','复盘'].includes(item.stage))))invalid(key+'条目格式或ID无效');ids.add(item.id);}}
 // 重要程度 / 紧急程度：用于默认排序与筛选。只认三档取值，不接受自造词。
 if(kind==='project'){
  for(const [key,label] of [['importance','重要程度'],['urgency','紧急程度']]){
   const value=data[key];
   if(value===undefined)continue;
   if(typeof value!=='string'||!['high','medium','low'].includes(value))invalid(label+'只能是 high / medium / low（高/中/低）');
  }
 }
 // 角色模型（A1）：角色名是**自由文本**（用户可以自定义模板），产品只给建议、不写死词表。
 // 单一语义：organization.defaultRole 的 '' 与缺省同义 = 未分类；非空时按 trim 后 1–40 字（纯空格不算空串）。
 if(kind==='organization'&&data.defaultRole!==undefined){
  const value=data.defaultRole;
  if(typeof value!=='string')invalid('默认角色必须为文本');
  if(value!==''&&(value.trim().length<1||value.trim().length>40))invalid('默认角色需为 1–40 字（空串表示未分类）');
 }
 // 项目模板只有 5 个键，缺省=不套模板。参与者每项**只允许** {organizationId, role} 两个字段，
 // 同一项目同一机构只一条（跨项目可不同）；机构是否存在由 store 在提交时用 resolve 硬拦（REFERENCE）。
 // project.organizationId（主责机构）可空，引用校验走 store 里 organizationId→organization 那一条，不重复实现。
 if(kind==='project'&&data.roleTemplate!==undefined&&!['delivery','ecosystem','investment','research','custom'].includes(data.roleTemplate))invalid('项目角色模板只能是 delivery / ecosystem / investment / research / custom');
 if(kind==='project'&&data.participants!==undefined){
  const list=data.participants;
  if(!Array.isArray(list)||list.length>200)invalid('参与者必须为数组（最多 200 条）');
  const seen=new Set();
  for(const item of list){
   if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['organizationId','role'].includes(key)))invalid('参与者条目只能包含 organizationId 与 role');
   if(typeof item.organizationId!=='string'||!item.organizationId.trim())invalid('参与者必须指定机构');
   if(typeof item.role!=='string'||item.role.trim().length<1||item.role.trim().length>40)invalid('参与者必须写明角色（1–40 字）');
   if(seen.has(item.organizationId))invalid('同一项目同一机构只能有一条参与者');
   seen.add(item.organizationId);
  }
 }
 // 阶段推进留痕：只记录真实发生过的阶段与时间，不预填、不推断。
 if(kind==='project'&&data.stageHistory!==undefined){
  const list=data.stageHistory;
  if(!Array.isArray(list)||list.length>200)invalid('阶段记录必须为数组');
  for(const entry of list){
   if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(key=>!['stage','at'].includes(key)))invalid('阶段记录条目格式无效');
   if(!['接触','需求','方案','验证','复盘'].includes(entry.stage))invalid('阶段记录包含未知阶段：'+entry.stage);
   if(typeof entry.at!=='string'||!entry.at.trim())invalid('阶段记录必须含时间');
  }
 }
 // 项目文件夹必须是**工作区内的相对路径**：绝对路径、.. 或空段都不接受（与目录授权同一套边界）。
 if(kind==='project'&&data.folder!==undefined){
  const folder=data.folder;
  if(typeof folder!=='string'||!folder.trim())invalid('项目文件夹必须是工作区内的相对路径');
  const parts=folder.trim().split('/');
  if(folder.startsWith('/')||parts.some(part=>part===''||part==='.'||part==='..'))invalid('项目文件夹不能是绝对路径，也不能包含 . 或 ..');
 }
 if(kind==='memoryRef'&&['provider','reference'].some(key=>typeof data[key]!=='string'||!data[key].trim()))invalid('记忆引用需要来源提供方和引用标识');
  // 信息简报必须能溯源：摘要、来源与登记时间不可缺；发布时间与链接状态可缺，但缺就是「未记录」，不得推断。
  if(kind==='brief'){
   if(typeof data.content!=='string'||!data.content.trim())invalid('信息简报需要摘要内容');
   if(typeof data.source!=='string'||!data.source.trim())invalid('信息简报需要来源名称');
   if(typeof data.fetchedAt!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]{8,}Z?|[+-]\d{2}:?\d{2})?$/.test(data.fetchedAt.trim()))invalid('信息简报需要登记时间（ISO 日期）');
   if('publishedAt'in data&&data.publishedAt!==undefined&&data.publishedAt!==''&&(typeof data.publishedAt!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]{8,}Z?|[+-]\d{2}:?\d{2})?$/.test(data.publishedAt.trim())))invalid('发布时间必须是 ISO 日期');
   if('sourceUrl'in data&&data.sourceUrl!==undefined&&data.sourceUrl!==''&&(typeof data.sourceUrl!=='string'||data.sourceUrl.length>500||!/^https?:\/\//.test(data.sourceUrl)))invalid('来源链接必须是 http(s) 地址');
   if('linkStatus'in data&&data.linkStatus!==undefined&&!['ok','expired','unknown'].includes(data.linkStatus))invalid('链接状态只能为 ok、expired 或 unknown');
   if('uncertainty'in data&&data.uncertainty!==undefined&&(typeof data.uncertainty!=='string'||data.uncertainty.length>300))invalid('不确定性说明过长');
  }
  // 记忆引用核验结果由 Agent 实际调用 Mnemon 后写入；插件不自行访问 Mnemon，也不允许把未核验写成已核验。
  if(kind==='memoryRef'&&'verification'in data){const value=data.verification;if(!value||typeof value!=='object'||Array.isArray(value))invalid('核对来源的结果格式无效');const keys=Object.keys(value);if(keys.some(key=>!['status','checkedAt','note'].includes(key)))invalid('核对来源的结果包含未知项');if(!['verified','missing','unverifiable'].includes(value.status))invalid('核对来源的状态只能是 已验证 / 来源中没找到 / 无法核对');if(typeof value.checkedAt!=='string'||!value.checkedAt.trim()||value.checkedAt.length>40)invalid('核对来源的结果需要带上核对时间');if(value.note!==undefined&&(typeof value.note!=='string'||value.note.length>200))invalid('核对来源的说明过长');}
  if(kind==='relation'&&(typeof data.evidence!=='string'||!data.evidence.trim()))invalid('这条关联还缺一句依据：写清为什么把它们连在一起');
  // 确认依据：记录确认时两端对象的版本，来源变化后据此把关系标为待复核（PRD KN-06）。
  if(kind==='relation'&&'basis'in data){const list=data.basis;if(!Array.isArray(list)||list.length>20||list.some(value=>typeof value!=='string'||!/^[^@]{1,200}@[1-9]\d*$/.test(value)))invalid('关系依据必须为「对象ID@版本」数组');}
 if(kind==='layout'){if(!data.positions||!data.viewport)invalid('布局需要坐标与视口');if(Object.keys(data.positions).length>1000)invalid('布局节点过多');if(data.positions){if(typeof data.positions!=='object'||Array.isArray(data.positions))invalid('布局格式无效');for(const p of Object.values(data.positions))if(!p||Array.isArray(p)||Object.keys(p).some(k=>!['x','y'].includes(k))||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e7||Math.abs(p.y)>1e7)invalid('坐标无效');}if(data.viewport&&(!Number.isFinite(data.viewport.x)||!Number.isFinite(data.viewport.y)||!Number.isFinite(data.viewport.zoom)||data.viewport.zoom<0.05||data.viewport.zoom>10||Array.isArray(data.viewport)||Object.keys(data.viewport).some(k=>!['x','y','zoom'].includes(k))))invalid('视口无效');}
 // 分组是**视图层**的数据（CV-05：聚焦/分组不改变业务事实）：只允许 id/名称/成员与折叠状态。
 if(kind==='layout'&&data.groups!==undefined){
  const groups=data.groups;
  if(!Array.isArray(groups)||groups.length>200)invalid('分组必须为数组（最多 200 组）');
  const seen=new Set();
  for(const group of groups){
   if(!group||typeof group!=='object'||Array.isArray(group)||Object.keys(group).some(key=>!['id','title','nodeIds','collapsed'].includes(key)))invalid('分组条目格式无效');
   if(typeof group.id!=='string'||!group.id.trim()||seen.has(group.id))invalid('分组 ID 无效或重复');
   seen.add(group.id);
   if(typeof group.title!=='string'||!group.title.trim())invalid('分组必须有名称');
   if(!Array.isArray(group.nodeIds)||!group.nodeIds.length||group.nodeIds.length>500||group.nodeIds.some(id=>typeof id!=='string'||!id.trim()))invalid('分组必须列出至少一个成员 ID');
   if(group.collapsed!==undefined&&typeof group.collapsed!=='boolean')invalid('折叠状态必须为布尔值');
  }
 }

 // 角色视觉映射是**视图层**数据（与 view:'ecosystem' 配套）：只存角色名→颜色/形状/顺序的映射，
 // 角色名本身的唯一事实源仍是 organization.defaultRole 与 project.participants[].role，这里不存第二份事实。
 // 颜色只认调色板变量（--pal-xxx / --pal-xxx-soft），**拒绝 hex 或任意值**；形状只认 5 种；每类最多 10 条。
 if(kind==='layout'){
  const roleName=value=>typeof value==='string'&&value.trim().length>=1&&value.trim().length<=40;
  for(const [key,label] of [['roleColors','角色颜色'],['roleShapes','角色形状']]){
   const value=data[key];
   if(value===undefined)continue;
   if(!value||typeof value!=='object'||Array.isArray(value))invalid(label+'必须是对象');
   const entries=Object.entries(value);
   if(entries.length>10)invalid(label+'最多 10 条');
   for(const [name,token] of entries){
    if(!roleName(name))invalid(label+'的角色名需为 1–40 字');
    if(key==='roleColors'&&(typeof token!=='string'||!/^--pal-[a-z]+(-soft)?$/.test(token)))invalid('角色颜色只能是调色板变量名（--pal-xxx）：'+name);
    if(key==='roleShapes'&&!['hexagon','diamond','square','circle','triangle'].includes(token))invalid('角色形状只能是 hexagon / diamond / square / circle / triangle：'+name);
   }
  }
  if(data.order!==undefined){
   const list=data.order;
   if(!Array.isArray(list)||list.length>10)invalid('角色顺序必须为数组（最多 10 条）');
   const seen=new Set();
   for(const name of list){
    if(!roleName(name))invalid('角色顺序里的角色名需为 1–40 字');
    if(seen.has(name.trim()))invalid('角色顺序不能重复：'+name.trim());
    seen.add(name.trim());
   }
  }
 }

 // 判断是一等公民（宪章第三条）：每条判断必须带依据、什么时候成立与状态。
 // 依据必须能指回原始出处，且要区分「对方自述」与「经第三方验证」。
 if(kind==='judgment'){
  const evidence=data.evidence;
  if(!Array.isArray(evidence)||!evidence.length||evidence.length>50)invalid('判断至少需要一条依据（最多 50 条）');
  for(const item of evidence){
   if(!item||typeof item!=='object'||Array.isArray(item))invalid('依据条目格式无效');
   if(Object.keys(item).some(key=>!['kind','ref','quote','verified'].includes(key)))invalid('依据条目包含未知项');
   if(!['message','file','audio','web','note'].includes(item.kind))invalid('依据来源只能是 会话原文 / 文件 / 录音 / 网页 / 你的口述');
   if(typeof item.ref!=='string'||!item.ref.trim()||item.ref.length>500)invalid('依据必须指回出处');
   if(typeof item.quote!=='string'||!item.quote.trim()||item.quote.length>300)invalid('依据需要一段出处原文（最多 300 字）');
   if(item.verified!==undefined&&typeof item.verified!=='boolean')invalid('依据的「是否经第三方验证」必须是是否值');
  }
  if(typeof data.validFrom!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]{8,}Z?|[+-]\d{2}:?\d{2})?$/.test(data.validFrom.trim()))invalid('判断需要「什么时候成立」（ISO 日期）');
  if(!['current','checking','overturned'].includes(data.status))invalid('判断状态只能是 当前有效 / 待核对 / 已被推翻');
  if(data.uncertainty!==undefined&&(typeof data.uncertainty!=='string'||data.uncertainty.length>300))invalid('不确定性说明过长（最多 300 字）');
  // 谁能看（F17）：只有两种值；**不写就是仅自己**（由导出方兜底，老数据仍可读）。
  if(data.share!==undefined&&!['private','team'].includes(data.share))invalid('谁能看只能是「仅自己」或「可以给同事看」');
  // 来源（用户 2026-10-17：「可以把来源记下来，最好只是 TAG」）：
  // 只记两态 —— who 起的草；老数据没有这个字段仍然可读（界面上就不显示那枚标签）。
  if(data.origin!==undefined&&!['ai','user'].includes(data.origin))invalid('判断的来源只能是「AI 起草」或「你说的」');
  if(data.reviewBy!==undefined&&(typeof data.reviewBy!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(data.reviewBy.trim())))invalid('复核时间必须是 ISO 日期');
  // 推翻要留痕：保留旧判断与理由，不抹掉「当时为什么这么想」。
  if(data.status==='overturned'){
   const o=data.overturnedBy;
   if(!o||typeof o!=='object'||Array.isArray(o))invalid('被推翻的判断必须留下推翻依据');
   if(Object.keys(o).some(key=>!['ref','reason','at'].includes(key)))invalid('推翻依据包含未知项');
   if(typeof o.reason!=='string'||!o.reason.trim()||o.reason.length>300)invalid('推翻理由不能为空（最多 300 字）');
   if(typeof o.at!=='string'||!o.at.trim()||o.at.length>40)invalid('推翻必须记录时间');
  }else if(data.overturnedBy!==undefined&&Object.keys(data.overturnedBy||{}).length)invalid('只有被推翻的判断才能带推翻依据');
 }
 // 生成视图（18 号 §3）：模板白名单、参数越界、basis / dataRefs 的硬约束只在 view-spec 一处实现，
 // 这里只做入口转发，避免两份校验漂移。
 if(kind==='view')validateViewDefinition(data);
}

/** 建议的说明（方案 A：不新增对象类型，挂在收件箱的待决定项上）。
 *  四个字段：依据（为什么这么建议）、不确定性、你的回应、你的理由；
 *  basedOn 记录它参考了你哪几条判断 —— 「为什么这么建议」靠它取数，取不到就必须自曝是通用建议。 */
export function validateProposal(proposal){
  // 分享边界（F17）：只有「仅自己 / 可以给同事看」两种；**不写就是仅自己**（宁可少分享）。
  // 导出时才读它，缺省值由导出方兜底，所以这里不强制必填，避免老数据写不进去。
 if(proposal===undefined)return undefined;
 if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))invalid('建议的说明格式无效');
 const allowed=new Set(['evidence','uncertainty','basedOn','decision','reason','decidedAt']);
 for(const key of Object.keys(proposal))if(!allowed.has(key))invalid('建议的说明包含未知项：'+key);
 const out={};
 if(proposal.evidence!==undefined){
  const list=proposal.evidence;
  if(!Array.isArray(list)||list.length>20)invalid('建议的依据最多 20 条');
  out.evidence=list.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item))invalid('建议的依据条目格式无效');
   if(Object.keys(item).some(key=>!['kind','ref','quote','verified'].includes(key)))invalid('建议的依据条目包含未知项');
   if(!['message','file','audio','web','note'].includes(item.kind))invalid('建议的依据来源只能是 会话原文 / 文件 / 录音 / 网页 / 你的口述');
   if(typeof item.ref!=='string'||!item.ref.trim()||item.ref.length>500)invalid('建议的依据必须指回出处');
   if(typeof item.quote!=='string'||!item.quote.trim()||item.quote.length>300)invalid('建议的依据需要一段出处原文（最多 300 字）');
   if(item.verified!==undefined&&typeof item.verified!=='boolean')invalid('建议的依据「是否经第三方验证」必须是是否值');
   return {kind:item.kind,ref:item.ref.trim(),quote:item.quote.trim(),...(item.verified===undefined?{}:{verified:item.verified})};
  });
 }
 if(proposal.uncertainty!==undefined){
  if(typeof proposal.uncertainty!=='string'||proposal.uncertainty.length>300)invalid('建议的不确定性说明最多 300 字');
  out.uncertainty=proposal.uncertainty.trim();
 }
 if(proposal.basedOn!==undefined){
  const list=proposal.basedOn;
  if(!Array.isArray(list)||list.length>20||list.some(value=>typeof value!=='string'||!value.trim()))invalid('建议参考的判断必须是非空文本数组（最多 20 条）');
  out.basedOn=[...new Set(list.map(value=>value.trim()))];
 }
 const decision=proposal.decision??'undecided';
 if(!['undecided','accepted','rewritten','rejected'].includes(decision))invalid('建议的回应只能是 待你决定 / 已采纳 / 已改写 / 已否决');
 out.decision=decision;
 if(proposal.reason!==undefined){
  if(typeof proposal.reason!=='string'||proposal.reason.length>300)invalid('你的理由最多 300 字');
  out.reason=proposal.reason.trim();
 }
 // 改写与否决**必须**留一句理由（采纳可免）——否则系统只学会顺从，学不到你的标准。
 if(decision==='rejected'&&!out.reason)invalid('否决要留一句理由：写清为什么不同意');
 if(decision==='rewritten'&&!out.reason)invalid('改写要留一句理由：写清改了什么');
 if(proposal.decidedAt!==undefined){
  if(typeof proposal.decidedAt!=='string'||!proposal.decidedAt.trim()||proposal.decidedAt.length>40)invalid('回应时间格式无效');
  out.decidedAt=proposal.decidedAt;
 }
 if(decision==='undecided'&&out.decidedAt)invalid('还没有回应就不该有回应时间');
 if(decision!=='undecided'&&!out.decidedAt)out.decidedAt=new Date().toISOString();
 return out;
}
