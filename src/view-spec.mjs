/** 生成视图（view v1）：模板目录、参数 schema、纯函数生成器、失效判定与保存路径。
 *
 *  依据：spec/18-生成视图规范-草案-20261018.md §3 契约 / §5 数据与出处 / §6 复现与导出；
 *        spec/27 §4 G1/G2 的做与不做。
 *
 *  这一层**不调模型、不写库、不读文件**：
 *    · `buildView` 只通过 store 的只读接口（get/list）取真实对象，构造「定义 + 渲染数据」；
 *    · 每个展示值都能落回 dataRefs 里的真实对象字段；落不到的（推断、估计）不显示数字，
 *      只以文字写进 reason 并如实说明；
 *    · 保存的是**定义**（模板 + 参数 + 引用 + 生成时间），不是渲染快照；
 *      `content` 只在预览里出现，`saveViewDraft` 会把它剥掉（18 号 §6）。
 *    · 失效口径与 relationStale 同一套：`id@revision` 的 revision 变了 → `stale`。
 *
 *  错误码沿用工作台既有语义：INVALID（模板/参数/契约）、REFERENCE（引用不可用）、
 *  UNAVAILABLE（没有真实数据，人话说明）、NOT_FOUND（保存过的视图不存在）。
 *  本模块不依赖其它 src 模块（view-spec → 无依赖），避免 validation/store 的循环引用。
 */
/** 新对象 ID：服务端用宿主全局 crypto；浏览器侧只会读不会走到保存分支，但模块必须能被 v7 打包（不能引 node:*）。 */
const randomUUID=()=>globalThis.crypto?.randomUUID?.()??('view-'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2,10));

const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};

/** v1 只允许这四类模板（18 号 §2.1）。未登记模板直接拒绝，不降级、不猜。 */
export const VIEW_TEMPLATES=Object.freeze(['risk-matrix','timeline','compare-table','blocker']);
/** v1 只允许这三种动作（18 号 §3.2）；其它动作先登记。 */
export const VIEW_ACTIONS=Object.freeze(['open-subject','save-as-judgment','save-as-brief']);
/** 依据词表沿用判断的 evidence（18 号 §3.2）：会话原文 / 文件 / 录音 / 网页 / 你的口述。 */
export const EVIDENCE_KINDS=Object.freeze(['message','file','audio','web','note']);
/** 保存方式：视图本身 / 存为判断 / 存为简报（18 号 §5.3）。 */
export const SAVE_AS=Object.freeze(['view','judgment','brief']);
/** 对比模板的维度目录。只做**结构化**比较；文字语义不做自动一致性判断（标 unrated）。 */
export const COMPARE_DIMENSIONS=Object.freeze([
 {id:'conclusion',label:'结论'},
 {id:'evidence',label:'依据数量'},
 {id:'verified',label:'经第三方验证'},
 {id:'uncertainty',label:'不确定性'},
 {id:'validFrom',label:'什么时候成立'},
 {id:'status',label:'状态'},
]);
const DIMENSION_IDS=COMPARE_DIMENSIONS.map(item=>item.id);
const DIMENSION_LABEL=new Map(COMPARE_DIMENSIONS.map(item=>[item.id,item.label]));

/** 每个模板的参数 schema（枚举 / 长度 / 上限，服务端校验；越界即 INVALID）。 */
const TEMPLATE_PARAMS=Object.freeze({
 'risk-matrix':['horizonDays'],
 timeline:[],
 'compare-table':['subjectIds','dimensions'],
 blocker:[],
});
const DEFAULT_HORIZON_DAYS=90;
const REF_LIMIT=50;
const BASIS_LIMIT=50;
const REF_PATTERN=/^([^@]{1,200})@([1-9]\d*)$/;
const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS=86400000;

const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const clampText=(value,max)=>{const text=value===undefined||value===null?'':String(value);return text.length>max?text.slice(0,max):text;};
const trimText=(value,max)=>{if(typeof value!=='string')return '';const text=value.trim();return text.length>max?text.slice(0,max):text;};
const refOf=item=>item.id+'@'+item.revision;
/** 取第一个非空文本（用于依据兜底；空串不能当依据原文）。 */
const firstText=(...values)=>{for(const value of values){const text=trimText(value,300);if(text)return text;}return '';};

const TASK_STATUS_LABELS=Object.freeze({todo:'待办',waiting:'等待中',in_progress:'进行中',done:'已完成',cancelled:'已取消'});
const JUDGMENT_STATUS_LABELS=Object.freeze({current:'当前有效',checking:'待核对',overturned:'已被推翻'});
const RISK_LABELS=Object.freeze({high:'高',medium:'中',low:'低'});
const EVIDENCE_LABELS=Object.freeze({strong:'强',medium:'中',weak:'弱',none:'无'});
const TIMELINE_STATE_LABELS=Object.freeze({done:'已完成',waiting:'在等',upcoming:'将到',overdue:'已过期'});
const KIND_LABELS=Object.freeze({project:'项目',task:'任务',judgment:'判断',topic:'议题',artifact:'资料',event:'日程',deliverable:'交付项',person:'联系人'});

function localIso(date){
 const pad=value=>String(value).padStart(2,'0');
 const offset=-date.getTimezoneOffset();
 const sign=offset>=0?'+':'-';
 const abs=Math.abs(offset);
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}
function dateOnly(value){
 const match=/^(\d{4}-\d{2}-\d{2})/.exec(String(value??''));
 return match?match[1]:null;
}
function dayNumber(value){
 const date=dateOnly(value);
 if(!date)return null;
 const stamp=Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7))-1,Number(date.slice(8,10)));
 return Number.isFinite(stamp)?Math.floor(stamp/DAY_MS):null;
}
function todayNumber(now){
 return Math.floor(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate())/DAY_MS);
}
function overdueDays(value,now){
 const day=dayNumber(value);
 return day===null?null:todayNumber(now)-day;
}

/** 模板参数校验 + 归一化（返回带默认值的副本，保证保存后可复现）。 */
export function normalizeTemplateParams(template,params){
 if(typeof template!=='string'||!VIEW_TEMPLATES.includes(template))fail('INVALID','模板未登记：'+String(template)+'（可用：'+VIEW_TEMPLATES.join(' / ')+'）');
 const raw=params===undefined?{}:params;
 if(!isObject(raw))fail('INVALID','模板参数必须是对象');
 const allowed=TEMPLATE_PARAMS[template]??[];
 for(const key of Object.keys(raw))if(!allowed.includes(key))fail('INVALID','模板 '+template+' 不接受参数：'+key);
 if(template==='risk-matrix'){
  const horizon=raw.horizonDays;
  if(horizon===undefined)return {horizonDays:DEFAULT_HORIZON_DAYS};
  if(!Number.isInteger(horizon)||horizon<1||horizon>3650)fail('INVALID','horizonDays 只能是 1–3650 的整数');
  return {horizonDays:horizon};
 }
 if(template==='compare-table'){
  const ids=raw.subjectIds;
  if(!Array.isArray(ids)||ids.length<2||ids.length>3)fail('INVALID','对比需要 2–3 个对象（params.subjectIds）');
  const subjectIds=ids.map(value=>trimText(value,200));
  if(subjectIds.some(value=>!value))fail('INVALID','对比对象必须是非空对象 ID');
  if(new Set(subjectIds).size!==subjectIds.length)fail('INVALID','对比对象不能重复');
  const dimensions=raw.dimensions===undefined?[...DIMENSION_IDS]:raw.dimensions;
  if(!Array.isArray(dimensions)||!dimensions.length||dimensions.length>DIMENSION_IDS.length)fail('INVALID','对比维度数量无效');
  if(dimensions.some(value=>typeof value!=='string'||!DIMENSION_IDS.includes(value)))fail('INVALID','对比维度未登记：'+dimensions.filter(value=>!DIMENSION_IDS.includes(value)).join(' / '));
  if(new Set(dimensions).size!==dimensions.length)fail('INVALID','对比维度不能重复');
  return {subjectIds,dimensions:[...dimensions]};
 }
 return {};
}

/** 依据列表校验 + 归一化（≥1 条、≤50 条、沿用判断的 evidence 词表）。 */
export function normalizeBasis(list){
 if(!Array.isArray(list)||!list.length)fail('INVALID','生成视图至少需要一条依据（basis）');
 if(list.length>BASIS_LIMIT)fail('INVALID','依据最多 '+BASIS_LIMIT+' 条');
 const seen=new Set(),out=[];
 for(const item of list){
  if(!isObject(item))fail('INVALID','依据条目格式无效');
  if(Object.keys(item).some(key=>!['kind','ref','quote','verified'].includes(key)))fail('INVALID','依据条目包含未知项');
  if(!EVIDENCE_KINDS.includes(item.kind))fail('INVALID','依据来源只能是 会话原文 / 文件 / 录音 / 网页 / 你的口述');
  const ref=trimText(item.ref,500);
  if(!ref)fail('INVALID','依据必须指回出处');
  const quote=trimText(item.quote,300);
  if(!quote)fail('INVALID','依据需要一段出处原文（最多 300 字）');
  if(item.verified!==undefined&&typeof item.verified!=='boolean')fail('INVALID','依据的「是否经第三方验证」必须是是否值');
  const key=item.kind+'|'+ref+'|'+quote;
  if(seen.has(key))continue;
  seen.add(key);
  out.push({kind:item.kind,ref,quote,...(item.verified===undefined?{}:{verified:item.verified})});
 }
 if(!out.length)fail('INVALID','生成视图至少需要一条依据（basis）');
 return out;
}

/** 引用列表校验 + 归一化：`对象ID@版本`、≤50 条、同一对象只出现一次。 */
export function normalizeDataRefs(list){
 if(!Array.isArray(list)||!list.length)fail('INVALID','视图至少需要一条数据引用（dataRefs）');
 if(list.length>REF_LIMIT)fail('INVALID','数据引用最多 '+REF_LIMIT+' 条（dataRefs）');
 const seen=new Set(),out=[];
 for(const ref of list){
  if(typeof ref!=='string')fail('INVALID','数据引用必须是「对象ID@版本」');
  const match=REF_PATTERN.exec(ref);
  if(!match)fail('INVALID','数据引用必须是「对象ID@版本」：'+clampText(ref,80));
  if(seen.has(match[1]))fail('INVALID','数据引用不能重复：'+match[1]);
  seen.add(match[1]);
  out.push(ref);
 }
 return out;
}

/** 按 18 号 §3.2 校验一条 view 定义（落库前的硬约束；内容字段 content 不在此列）。 */

/** AI 解读（spec/18 v1.1）：模型写的结论必须引用 dataRefs 里的真实对象；字数受限。 */
export function validateViewAnalysis(analysis,dataRefs,origin){
 if(analysis===undefined)return;
 if(!isObject(analysis))fail('INVALID','AI 解读必须是对象');
 const allowed=['summary','findings','uncertainty'];
 for(const key of Object.keys(analysis))if(!allowed.includes(key))fail('INVALID','AI 解读包含未知项：'+key);
 if(origin!=='ai')fail('INVALID','只有 AI 生成的视图可以带 AI 解读');
 const summary=trimText(analysis.summary,600);
 if(analysis.summary!==undefined&&typeof analysis.summary!=='string')fail('INVALID','AI 解读的结论必须是文本');
 if(analysis.summary!==undefined&&!summary)fail('INVALID','AI 解读的结论不能为空');
 if(typeof analysis.summary==='string'&&analysis.summary.length>600)fail('INVALID','AI 解读的结论最多 600 字');
 if(analysis.uncertainty!==undefined){if(typeof analysis.uncertainty!=='string'||analysis.uncertainty.length>300)fail('INVALID','AI 解读的不确定性最多 300 字');}
 if(analysis.findings!==undefined){
  if(!Array.isArray(analysis.findings)||analysis.findings.length>8||!analysis.findings.length)fail('INVALID','AI 解读的逐条依据需要 1–8 条');
  const refs=new Set(dataRefs??[]);
  for(const finding of analysis.findings){
   if(!isObject(finding)||Object.keys(finding).some(key=>!['ref','text'].includes(key)))fail('INVALID','AI 解读的每条依据格式无效');
   const ref=trimText(finding?.ref,200);const text=trimText(finding?.text,300);
   if(!ref||!text)fail('INVALID','AI 解读的每条依据都需要 ref 与 text');
   if(!refs.has(ref))fail('INVALID','AI 解读引用了视图里没有的对象：'+ref);
  }
 }
 if(!summary&&!(analysis.findings??[]).length)fail('INVALID','AI 解读至少需要一句结论或一条依据');
}

export function validateViewDefinition(data){
 if(!isObject(data))fail('INVALID','视图数据必须是对象');
 const allowed=['title','description','template','subject','params','dataRefs','basis','generatedAt','origin','state','actions','savedAs','analysis'];
 for(const key of Object.keys(data))if(!allowed.includes(key))fail('INVALID','未知或受保护字段：'+key);
 if(!trimText(data.title,500))fail('INVALID','视图需要标题');
 if(data.description!==undefined&&typeof data.description!=='string')fail('INVALID','视图说明必须是文本');
 if(typeof data.template!=='string'||!VIEW_TEMPLATES.includes(data.template))fail('INVALID','模板未登记：'+String(data.template)+'（可用：'+VIEW_TEMPLATES.join(' / ')+'）');
 normalizeTemplateParams(data.template,data.params);
 if(!isObject(data.subject))fail('INVALID','视图需要 subject（对象 ID、类型、版本）');
 if(Object.keys(data.subject).some(key=>!['id','kind','revision'].includes(key)))fail('INVALID','subject 只能包含 id / kind / revision');
 const subjectId=trimText(data.subject.id,200);
 if(!subjectId)fail('INVALID','subject.id 不能为空');
 if(typeof data.subject.kind!=='string'||!data.subject.kind.trim()||data.subject.kind.length>50)fail('INVALID','subject.kind 不能为空');
 if(!Number.isInteger(data.subject.revision)||data.subject.revision<1)fail('INVALID','subject.revision 必须是正整数');
 const refs=normalizeDataRefs(data.dataRefs);
 if(!refs.includes(subjectId+'@'+data.subject.revision))fail('INVALID','subject 必须在 dataRefs 里（对象ID@版本）');
 normalizeBasis(data.basis);
 validateViewAnalysis(data.analysis,refs,data.origin);
 if(typeof data.generatedAt!=='string'||!ISO_DATETIME.test(data.generatedAt)||!Number.isFinite(Date.parse(data.generatedAt)))fail('INVALID','generatedAt 必须是带时区的时间');
 if(data.origin!==undefined&&!['ai','user'].includes(data.origin))fail('INVALID','视图来源只能是「AI 生成」或「你说的」');
 if(!['fresh','stale'].includes(data.state))fail('INVALID','视图状态只能是 fresh 或 stale');
 if(!Array.isArray(data.actions)||!data.actions.length||data.actions.length>3||data.actions.some(action=>!VIEW_ACTIONS.includes(action)))fail('INVALID','视图动作只能是 open-subject / save-as-judgment / save-as-brief（最多 3 个）');
 if(new Set(data.actions).size!==data.actions.length)fail('INVALID','视图动作不能重复');
 if(data.savedAs!==undefined&&(typeof data.savedAs!=='string'||!data.savedAs.trim()||data.savedAs.length>200))fail('INVALID','savedAs 必须是对象 ID');
 return data;
}

/** 失效判定（纯函数）：引用对象的 revision 变化 / 归档 / 消失 → stale。
 *  与 graph.mjs 的 relationStale 同一套口径，不另造状态。lookup(id) 返回 {id,revision,archived} 或 null。 */
export function computeStale(dataRefs,lookup){
 if(!Array.isArray(dataRefs))fail('INVALID','数据引用必须是数组');
 const changed=[];
 for(const ref of dataRefs){
  const match=typeof ref==='string'?REF_PATTERN.exec(ref):null;
  if(!match){changed.push({ref:String(ref??''),id:null,expectedRevision:null,currentRevision:null,reason:'引用格式无法识别'});continue;}
  const id=match[1],expectedRevision=Number(match[2]),current=typeof lookup==='function'?lookup(id):null;
  if(!current)changed.push({ref,id,expectedRevision,currentRevision:null,reason:'引用对象已不可用'});
  else if(current.archived)changed.push({ref,id,expectedRevision,currentRevision:current.revision??null,reason:'引用对象已归档'});
  else if(current.revision!==expectedRevision)changed.push({ref,id,expectedRevision,currentRevision:current.revision,reason:'引用对象已更新'});
 }
 return {state:changed.length?'stale':'fresh',changed};
}
export function storeLookup(store,ctx){return id=>store.get(ctx,id);}
export function staleForView(store,ctx,view){return computeStale(view?.dataRefs??[],storeLookup(store,ctx));}

function createCollectors(subject){
 const refs=new Map([[subject.id,refOf(subject)]]);
 const basis=new Map();
 const collector={
  get size(){return refs.size;},
  hasRef(item){return Boolean(item)&&refs.has(item.id);},
  addRef(item){
   if(!item||typeof item.id!=='string'||!Number.isInteger(item.revision))return false;
   if(refs.has(item.id))return true;
   if(refs.size>=REF_LIMIT)return false;
   refs.set(item.id,refOf(item));
   return true;
  },
  addBasis(entry){
   if(!entry||basis.size>=BASIS_LIMIT)return;
   try{const [normalized]=normalizeBasis([entry]);const key=normalized.kind+'|'+normalized.ref+'|'+normalized.quote;if(!basis.has(key))basis.set(key,normalized);}catch{/* 不可引用的依据不放进视图 */}
  },
  refList(){return [...refs.values()];},
  basisList(){return [...basis.values()];},
 };
 return collector;
}
const noteBasis=(item,quote,extra={})=>({kind:'note',ref:refOf(item),quote:clampText(quote,300),...extra});
const fileBasis=artifact=>({kind:'file',ref:refOf(artifact),quote:clampText(artifact.data?.title??artifact.id,300)});
const evidenceBasis=evidence=>({kind:evidence.kind,ref:clampText(evidence.ref,500),quote:clampText(evidence.quote,300),...(evidence.verified===true?{verified:true}:{})});

function loadSubject(store,ctx,id,template){
 if(typeof id!=='string'||!id.trim())fail('INVALID','需要对象 ID（subjectId）');
 const item=store.get(ctx,id.trim());
 if(!item||item.archived)fail('REFERENCE','引用的对象不可用：'+id.trim());
 const allowed={ 'risk-matrix':['project'],timeline:['project'],blocker:['task'] }[template];
 if(allowed&&!allowed.includes(item.kind))fail('INVALID',template+' 只能用在'+allowed.map(kind=>KIND_LABELS[kind]??kind).join(' / ')+'上，当前对象是'+(KIND_LABELS[item.kind]??item.kind));
 return item;
}
function listChildren(store,ctx,kind,projectId){
 return store.list(ctx,{kind,projectId,limit:1000}).filter(item=>item&&!item.archived);
}
function listAll(store,ctx,kind){
 return store.list(ctx,{kind,limit:1000}).filter(item=>item&&!item.archived);
}
function strengthOf(count,verified){
 if(verified>0)return 'strong';
 if(count>=2)return 'medium';
 if(count===1)return 'weak';
 return 'none';
}
function riskWeight(risk){return risk==='high'?0:risk==='medium'?1:2;}
function ageReason(dueDate,now){
 const days=overdueDays(dueDate,now);
 return days===null||days<=0?null:'已过期 '+days+' 天';
}

/* ── 模板 1：risk-matrix（项目详情 · 风险 × 证据强度） ───────────────────────── */

function buildRiskMatrix(store,ctx,project,params,now){
 const horizon=params.horizonDays;
 const today=todayNumber(now);
 const judgments=listChildren(store,ctx,'judgment',project.id);
 const tasks=listChildren(store,ctx,'task',project.id);
 const artifacts=listAll(store,ctx,'artifact');
 const artifactsOfTask=task=>artifacts.filter(artifact=>(artifact.data?.taskIds??[]).includes(task.id));
 const horizonLimit=today+horizon;
 const inHorizon=value=>{const day=dayNumber(value);return day===null||day<=horizonLimit;};
 const candidates=[];
 for(const judgment of judgments){
  const status=judgment.data?.status??'current';
  const risk=status==='overturned'?'high':status==='checking'?'medium':'low';
  const evidence=Array.isArray(judgment.data?.evidence)?judgment.data.evidence:[];
  const verified=evidence.filter(item=>item?.verified===true).length;
  candidates.push({
   weight:riskWeight(risk),sortKey:judgment.id,source:judgment,
   row:{id:judgment.id,kind:'judgment',title:clampText(judgment.data?.title??judgment.id,200),risk,riskLabel:RISK_LABELS[risk],
    evidenceStrength:strengthOf(evidence.length,verified),evidenceCount:evidence.length,verifiedCount:verified,
    reason:'判断当前为「'+(JUDGMENT_STATUS_LABELS[status]??status)+'」；带 '+evidence.length+' 条依据（其中经第三方验证 '+verified+' 条）。'},
   objects:[judgment],basis:evidence.map(evidenceBasis),
  });
 }
 for(const task of tasks){
  const status=task.data?.status??'todo';
  if(['done','cancelled'].includes(status))continue;
  const blockedReason=trimText(task.data?.blockedReason,300);
  const dueDate=dateOnly(task.data?.dueDate);
  const overdue=dueDate!==null&&(overdueDays(dueDate,now)??0)>0;
  if(!blockedReason&&status!=='waiting'&&!overdue)continue;
  if(!inHorizon(dueDate))continue;
  const linked=artifactsOfTask(task);
  const evidenceCount=linked.length;
  const risk=blockedReason||status==='waiting'?'high':'medium';
  const reason=blockedReason
   ?'任务记录了阻塞：'+clampText(blockedReason,120)
   :status==='waiting'
    ?'任务状态为「等待中」，但没有写阻塞原因。'
    :'原定 '+dueDate+' 截止，'+(ageReason(dueDate,now)??'已过期')+'，当前状态「'+(TASK_STATUS_LABELS[status]??status)+'」。';
  const basis=[];
  if(blockedReason)basis.push(noteBasis(task,'阻塞原因：'+blockedReason));
  for(const artifact of linked)basis.push(fileBasis(artifact));
  if(!basis.length)basis.push(noteBasis(task,reason));
  candidates.push({
   weight:riskWeight(risk),sortKey:task.id,source:task,
   row:{id:task.id,kind:'task',title:clampText(task.data?.title??task.id,200),risk,riskLabel:RISK_LABELS[risk],
    evidenceStrength:strengthOf(evidenceCount,0),evidenceCount,verifiedCount:0,reason},
   objects:[task,...linked],basis,
  });
 }
 for(const deliverable of project.data?.deliverables??[]){
  if(!deliverable||deliverable.done===true)continue;
  const dueDate=dateOnly(deliverable.dueDate);
  if(!dueDate||(overdueDays(dueDate,now)??0)<=0)continue;
  if(!inHorizon(dueDate))continue;
  const reason='交付项「'+clampText(deliverable.title,80)+'」原定 '+dueDate+' 截止，仍未完成（已过期 '+(overdueDays(dueDate,now)??0)+' 天）。';
  candidates.push({
   weight:riskWeight('high'),sortKey:deliverable.id,source:project,
   row:{id:deliverable.id,kind:'deliverable',title:clampText(deliverable.title,200),risk:'high',riskLabel:RISK_LABELS.high,
    evidenceStrength:'none',evidenceCount:0,verifiedCount:0,reason},
   objects:[project],basis:[noteBasis(project,reason)],
  });
 }
 const projectDue=dateOnly(project.data?.dueDate);
 if(projectDue&&(overdueDays(projectDue,now)??0)>0&&inHorizon(projectDue)){
  const stage=trimText(project.data?.stage,40)||'未登记阶段';
  const reason='项目截止日期 '+projectDue+' 已过（'+(ageReason(projectDue,now)??'已过期')+'），当前阶段「'+stage+'」。';
  candidates.push({
   weight:riskWeight('high'),sortKey:project.id,source:project,
   row:{id:project.id,kind:'project',title:'项目截止日期已过',risk:'high',riskLabel:RISK_LABELS.high,
    evidenceStrength:'none',evidenceCount:0,verifiedCount:0,reason},
   objects:[project],basis:[noteBasis(project,reason)],
  });
 }
 candidates.sort((left,right)=>left.weight-right.weight||left.sortKey.localeCompare(right.sortKey));
 const collector=createCollectors(project);
 const rows=[];
 for(const candidate of candidates){
  const fresh=candidate.objects.filter(item=>!collector.hasRef(item));
  if(collector.size+fresh.length>REF_LIMIT)break;
  for(const item of fresh)collector.addRef(item);
  for(const entry of candidate.basis)collector.addBasis(entry);
  rows.push({...candidate.row,refs:candidate.objects.map(refOf)});
 }
 if(!rows.length)fail('UNAVAILABLE','这个项目还没有可判断的风险信号（任务阻塞、待核对判断、过期交付和过期截止都没有）—— 先补任务、判断或交付，再生成。');
 if(!collector.basisList().length)collector.addBasis(noteBasis(project,firstText(project.data?.goal,project.data?.description,project.data?.title,project.id)));
 const counts={high:rows.filter(row=>row.risk==='high').length,medium:rows.filter(row=>row.risk==='medium').length,low:rows.filter(row=>row.risk==='low').length,total:rows.length};
 return {
  title:clampText((project.data?.title??project.id)+' · 风险与证据',500),
  content:{template:'risk-matrix',columns:[{id:'risk',label:'风险'},{id:'evidence',label:'证据强度'},{id:'level',label:'等级'},{id:'basis',label:'出处'}],rows,counts,horizonDays:horizon},
  refs:collector.refList(),basis:collector.basisList(),
  actions:['open-subject','save-as-judgment','save-as-brief'],
 };
}

/* ── 模板 2：timeline（项目详情 · 里程碑 / 交付 / 判断的时间顺序） ───────────── */

function buildTimeline(store,ctx,project,params,now){
 const today=todayNumber(now);
 const judgments=listChildren(store,ctx,'judgment',project.id);
 const tasks=listChildren(store,ctx,'task',project.id);
 const events=listChildren(store,ctx,'event',project.id);
 const taskById=new Map(tasks.map(task=>[task.id,task]));
 const candidates=[];
 const push=(at,payload,basis)=>{const date=dateOnly(at);if(date)candidates.push({at:date,...payload,basis});};
 const stateOfDate=date=>{const day=dayNumber(date);if(day===null)return null;return day<today?'overdue':day===today?'done':'upcoming';};
 (project.data?.stageHistory??[]).forEach((entry,index)=>{
  const at=dateOnly(entry?.at);
  if(!at)return;
  push(at,{id:project.id+'#stage:'+index+':'+at,kind:'project',title:'阶段推进到「'+clampText(entry.stage,20)+'」',state:'done',stateLabel:TIMELINE_STATE_LABELS.done,waiting:false,waitingOn:null,reason:null,objects:[project]},[noteBasis(project,'阶段记录：'+entry.stage+'（'+at+'）')]);
 });
 const startDate=dateOnly(project.data?.startDate);
 if(startDate){
  const state=stateOfDate(startDate)??'upcoming';
  push(startDate,{id:project.id+'#start',kind:'project',title:'项目开始',state,stateLabel:TIMELINE_STATE_LABELS[state],waiting:false,waitingOn:null,reason:null,objects:[project]},[noteBasis(project,'项目开始：'+startDate)]);
 }
 const dueDate=dateOnly(project.data?.dueDate);
 if(dueDate){
  const overdue=(overdueDays(dueDate,now)??0)>0;
  const state=overdue?'overdue':'upcoming';
  push(dueDate,{id:project.id+'#due',kind:'project',title:'项目截止',state,stateLabel:overdue?'已过期':TIMELINE_STATE_LABELS[state],waiting:overdue,waitingOn:null,reason:overdue?'截止日期已过，项目仍未完成':null,objects:[project]},[noteBasis(project,'项目截止：'+dueDate)]);
 }
 for(const deliverable of project.data?.deliverables??[]){
  const at=dateOnly(deliverable.dueDate);
  if(!at)continue;
  const done=deliverable.done===true;
  const overdue=!done&&(overdueDays(at,now)??0)>0;
  const state=done?'done':overdue?'overdue':'upcoming';
  push(at,{id:deliverable.id,kind:'deliverable',title:clampText(deliverable.title,200),state,stateLabel:TIMELINE_STATE_LABELS[state],waiting:overdue,waitingOn:null,reason:overdue?'交付项未完成且已过期':'',objects:[project]},[noteBasis(project,'交付项「'+clampText(deliverable.title,80)+'」：'+(done?'已完成':'原定 '+at+' 截止，未完成'))]);
 }
 for(const task of tasks){
  const at=dateOnly(task.data?.dueDate);
  if(!at)continue;
  const status=task.data?.status??'todo';
  if(status==='cancelled')continue;
  const blockedReason=trimText(task.data?.blockedReason,300);
  const incompleteDeps=(task.data?.dependsOn??[]).map(id=>taskById.get(id)).filter(dep=>dep&&!['done','cancelled'].includes(dep.data?.status??'todo'));
  const overdue=status!=='done'&&(overdueDays(at,now)??0)>0;
  const waiting=status==='waiting'||Boolean(blockedReason)||incompleteDeps.length>0||overdue;
  const state=status==='done'?'done':overdue?'overdue':waiting?'waiting':'upcoming';
  const waitingOn=incompleteDeps[0]?{id:incompleteDeps[0].id,title:clampText(incompleteDeps[0].data?.title??incompleteDeps[0].id,200),kind:'task'}:null;
  const reason=waiting?
   (blockedReason?'记录的阻塞原因：'+clampText(blockedReason,120):
    incompleteDeps.length?'依赖任务还没完成：'+clampText(incompleteDeps[0].data?.title??incompleteDeps[0].id,80):
    overdue?'原定 '+at+' 截止，已过期':'任务状态为「'+(TASK_STATUS_LABELS[status]??status)+'」'):null;
  const basis=[];
  if(blockedReason)basis.push(noteBasis(task,'阻塞原因：'+blockedReason));
  if(incompleteDeps.length)basis.push(noteBasis(task,'依赖任务：'+incompleteDeps.map(dep=>dep.data?.title??dep.id).join('、')));
  if(!basis.length)basis.push(noteBasis(task,'任务「'+clampText(task.data?.title??task.id,80)+'」截止 '+at+'，状态「'+(TASK_STATUS_LABELS[status]??status)+'」'));
  push(at,{id:task.id,kind:'task',title:clampText(task.data?.title??task.id,200),state,stateLabel:status==='done'?'已完成':waiting?'在等':TIMELINE_STATE_LABELS[state],waiting,waitingOn,reason,objects:[task,...incompleteDeps]},basis);
 }
 for(const judgment of judgments){
  const at=dateOnly(judgment.data?.validFrom);
  if(!at)continue;
  const status=judgment.data?.status??'current';
  const waiting=status==='checking';
  const state=status==='overturned'?'overdue':waiting?'waiting':'done';
  const uncertainty=trimText(judgment.data?.uncertainty,300);
  const basis=(judgment.data?.evidence??[]).map(evidenceBasis);
  if(!basis.length)basis.push(noteBasis(judgment,'判断：'+clampText(judgment.data?.title??judgment.id,120)));
  push(at,{id:judgment.id,kind:'judgment',title:clampText(judgment.data?.title??judgment.id,200),state,stateLabel:status==='overturned'?'已被推翻':waiting?'待核对':'判断成立',waiting,waitingOn:null,reason:waiting?'待核对'+(uncertainty?'：'+clampText(uncertainty,120):''):null,objects:[judgment]},basis);
 }
 for(const event of events){
  const at=dateOnly(event.data?.startDate);
  if(!at)continue;
  const past=(dayNumber(at)??0)<today;
  push(at,{id:event.id,kind:'event',title:clampText(event.data?.title??event.id,200),state:past?'done':'upcoming',stateLabel:past?'已发生':'将到',waiting:false,waitingOn:null,reason:null,objects:[event]},[noteBasis(event,'日程：'+(event.data?.title??event.id)+'（'+at+'）')]);
 }
 candidates.sort((left,right)=>left.at===right.at?left.id.localeCompare(right.id):left.at.localeCompare(right.at));
 let picked=candidates;
 let truncated=false;
 if(picked.length>REF_LIMIT-1){
  truncated=true;
  const scored=picked.map(item=>({item,distance:Math.abs((dayNumber(item.at)??today)-today)}))
   .sort((left,right)=>left.distance-right.distance||left.item.at.localeCompare(right.item.at)||left.item.id.localeCompare(right.item.id))
   .slice(0,REF_LIMIT-1).map(entry=>entry.item);
  picked=scored.sort((left,right)=>left.at===right.at?left.id.localeCompare(right.id):left.at.localeCompare(right.at));
 }
 const collector=createCollectors(project);
 const items=[];
 for(const candidate of picked){
  const fresh=candidate.objects.filter(item=>!collector.hasRef(item));
  if(collector.size+fresh.length>REF_LIMIT)continue;
  for(const item of fresh)collector.addRef(item);
  for(const entry of candidate.basis)collector.addBasis(entry);
  const {objects,basis,...item}=candidate;
  items.push({...item,refs:objects.map(refOf)});
 }
 if(!items.length)fail('UNAVAILABLE','这个项目还没有带日期的里程碑、交付、判断或日程 —— 先补日期，再生成时间线。');
 if(!collector.basisList().length)collector.addBasis(noteBasis(project,firstText(project.data?.goal,project.data?.description,project.data?.title,project.id)));
 const waitingItem=items.find(item=>item.waiting)??null;
 return {
  title:clampText((project.data?.title??project.id)+' · 时间线',500),
  content:{template:'timeline',items,range:{from:items[0]?.at??null,to:items[items.length-1]?.at??null},truncated,waiting:waitingItem?{id:waitingItem.id,title:waitingItem.title,reason:waitingItem.reason??null}:null},
  refs:collector.refList(),basis:collector.basisList(),
  actions:['open-subject','save-as-judgment','save-as-brief'],
 };
}

/* ── 模板 3：compare-table（知识页 · 2–3 份判断/材料的维度对比） ─────────────── */

function compareCell(dimension,item,now){
 const data=item.data??{};
 if(dimension==='conclusion'){
  return item.kind==='judgment'
   ?{value:clampText(data.title??item.id,120),field:'title',compareKey:'title:'+String(data.title??item.id)}
   :{value:data.content?clampText(data.content,120):clampText(data.title??item.id,120),field:data.content?'content':'title',compareKey:data.content?'content:'+String(data.content):'title:'+String(data.title??item.id)};
 }
 if(item.kind!=='judgment')return {value:null,field:null,compareKey:null};
 if(dimension==='evidence'){
  const evidence=Array.isArray(data.evidence)?data.evidence:[];
  const verified=evidence.filter(entry=>entry?.verified===true).length;
  return {value:evidence.length+' 条',field:'evidence',compareKey:'n:'+evidence.length,detail:{count:evidence.length,verified}};
 }
 if(dimension==='verified'){
  const evidence=Array.isArray(data.evidence)?data.evidence:[];
  const verified=evidence.filter(entry=>entry?.verified===true).length;
  return {value:verified>0?'有经第三方验证的依据':'没有经第三方验证的依据',field:'evidence',compareKey:'v:'+(verified>0)};
 }
 if(dimension==='uncertainty'){
  const uncertainty=trimText(data.uncertainty,120);
  return {value:uncertainty||null,field:'uncertainty',compareKey:uncertainty?'u:'+uncertainty:null};
 }
 if(dimension==='validFrom')return {value:dateOnly(data.validFrom)??null,field:'validFrom',compareKey:data.validFrom??null};
 if(dimension==='status'){
  const status=data.status??null;
  return {value:status?(JUDGMENT_STATUS_LABELS[status]??status):null,field:'status',compareKey:status};
 }
 return {value:null,field:null,compareKey:null};
}
function compareRowStatus(dimension,cells){
 const present=cells.filter(cell=>cell.value!==null);
 if(!present.length||present.length<cells.length)return 'missing';
 const keys=new Set(cells.map(cell=>cell.compareKey));
 if(keys.size===1)return 'same';
 if(['conclusion','uncertainty'].includes(dimension))return 'unrated';
 return 'diff';
}

function buildCompareTable(store,ctx,sources,params,now){
 for(const source of sources){
  if(!['judgment','topic'].includes(source.kind))fail('INVALID','对比只支持判断和议题，当前对象是'+(KIND_LABELS[source.kind]??source.kind));
 }
 const anchor=sources[0];
 const collector=createCollectors(anchor);
 for(const source of sources)collector.addRef(source);
 const matrix=params.dimensions.map(dimension=>{
  const rawCells=sources.map(source=>({...compareCell(dimension,source,now),ref:refOf(source)}));
  const status=compareRowStatus(dimension,rawCells);
  return {id:dimension,label:DIMENSION_LABEL.get(dimension)??dimension,cells:rawCells.map(cell=>({value:cell.value,status,ref:cell.ref,field:cell.field??null}))};
 });
 const agreement={same:0,diff:0,missing:0,unrated:0};
 for(const row of matrix)agreement[row.cells[0].status]+=1;
 if(agreement.missing===matrix.length)fail('UNAVAILABLE','这几条对象都没有可对比的结构化字段（依据 / 验证 / 不确定性 / 成立时间 / 状态）—— 对比至少需要一条判断。');
 const basis=[];
 for(const source of sources){
  if(source.kind==='judgment'){
   const evidence=(source.data?.evidence??[]).map(evidenceBasis);
   if(evidence.length)basis.push(...evidence);
   else basis.push(noteBasis(source,'判断：'+clampText(source.data?.title??source.id,120)));
  }else{
   basis.push(noteBasis(source,source.data?.content??source.data?.title??source.id));
  }
 }
 for(const entry of basis)collector.addBasis(entry);
 if(!collector.basisList().length)collector.addBasis(noteBasis(anchor,anchor.data?.title??anchor.id));
 return {
  title:clampText('对比 · '+sources.map(source=>clampText(source.data?.title??source.id,120)).join(' / '),500),
  content:{template:'compare-table',sources:sources.map(source=>({id:source.id,kind:source.kind,title:clampText(source.data?.title??source.id,200),revision:source.revision,ref:refOf(source)})),dimensions:params.dimensions.map(dimension=>({id:dimension,label:DIMENSION_LABEL.get(dimension)??dimension})),matrix,agreement},
  refs:collector.refList(),basis:collector.basisList(),
  actions:['save-as-judgment','save-as-brief'],
 };
}

/* ── 模板 4：blocker（任务详情 · 卡在哪、等谁、下一步） ──────────────────────── */

function buildBlocker(store,ctx,task,params,now){
 const status=task.data?.status??'todo';
 if(['done','cancelled'].includes(status))fail('UNAVAILABLE','这个任务已经完成或取消，没有可解释的阻塞。');
 const blockedReason=trimText(task.data?.blockedReason,300);
 const dueDate=dateOnly(task.data?.dueDate);
 const overdue=(overdueDays(dueDate,now)??0)>0;
 const dependencies=(task.data?.dependsOn??[]).map(id=>store.get(ctx,id));
 const incomplete=dependencies.filter(dep=>dep&&!dep.archived&&!['done','cancelled'].includes(dep.data?.status??'todo'));
 const owner=task.data?.ownerId?store.get(ctx,task.data.ownerId):null;
 const collector=createCollectors(task);
 const chain=[];
 chain.push({id:task.id,kind:'task',title:clampText(task.data?.title??task.id,200),state:blockedReason||status==='waiting'?'waiting':'open',stateLabel:blockedReason?'记录阻塞':(TASK_STATUS_LABELS[status]??status),reason:blockedReason?clampText(blockedReason,200):null,ref:refOf(task)});
 for(const dependency of incomplete){
  const depStatus=dependency.data?.status??'todo';
  chain.push({id:dependency.id,kind:'task',title:clampText(dependency.data?.title??dependency.id,200),state:depStatus==='waiting'?'waiting':'blocked',stateLabel:'未完成（'+(TASK_STATUS_LABELS[depStatus]??depStatus)+'）',reason:clampText(dependency.data?.blockedReason??'',200)||null,ref:refOf(dependency)});
 }
 const waitingOn=[];
 for(const dependency of incomplete){
  waitingOn.push({id:dependency.id,kind:'task',title:clampText(dependency.data?.title??dependency.id,200),ref:refOf(dependency)});
  const depOwner=dependency.data?.ownerId?store.get(ctx,dependency.data.ownerId):null;
  if(depOwner&&!waitingOn.some(item=>item.id===depOwner.id))waitingOn.push({id:depOwner.id,kind:'person',title:clampText(depOwner.data?.title??depOwner.id,120),ref:refOf(depOwner)});
 }
 const nextSteps=[];
 if(incomplete.length)nextSteps.push({label:'先推进依赖任务：'+clampText(incomplete[0].data?.title??incomplete[0].id,80),reason:'任务依赖里还有未完成项',refs:[refOf(incomplete[0])]});
 if(blockedReason)nextSteps.push({label:'确认阻塞是否解除：'+clampText(blockedReason,120),reason:'任务记录了阻塞原因',refs:[refOf(task)]});
 if(overdue)nextSteps.push({label:'重排截止时间（原定 '+dueDate+'，已过期 '+overdueDays(dueDate,now)+' 天）',reason:'截止日期已过且任务未完成',refs:[refOf(task)]});
 if(!nextSteps.length)nextSteps.push({label:'把「在等谁」写清楚',reason:'任务在等待，但没有记录依赖或阻塞原因',refs:[refOf(task)]});
 const basis=[];
 if(blockedReason)basis.push(noteBasis(task,'阻塞原因：'+blockedReason));
 for(const dependency of incomplete)basis.push(noteBasis(dependency,'依赖任务「'+clampText(dependency.data?.title??dependency.id,80)+'」尚未完成'));
 if(overdue)basis.push(noteBasis(task,'截止日期 '+dueDate+'，已过期 '+overdueDays(dueDate,now)+' 天'));
 if(!basis.length)basis.push(noteBasis(task,'任务状态：'+(TASK_STATUS_LABELS[status]??status)));
 if(!blockedReason&&status!=='waiting'&&!incomplete.length&&!overdue)fail('UNAVAILABLE','这个任务没有记录阻塞、也没有未完成的依赖 —— 现在没有可解释的「卡在哪」。');
 for(const entry of basis)collector.addBasis(entry);
 if(!collector.basisList().length)collector.addBasis(noteBasis(task,firstText(task.data?.title,task.id)));
 for(const item of [task,...incomplete,...(owner?[owner]:[])])collector.addRef(item);
 for(const dependency of incomplete){const depOwner=dependency.data?.ownerId?store.get(ctx,dependency.data.ownerId):null;if(depOwner)collector.addRef(depOwner);}
 return {
  title:clampText((task.data?.title??task.id)+' · 卡在哪',500),
  content:{template:'blocker',task:{id:task.id,title:clampText(task.data?.title??task.id,200),revision:task.revision,status,statusLabel:TASK_STATUS_LABELS[status]??status,blockedReason:blockedReason||null,dueDate,owner:owner?{id:owner.id,title:clampText(owner.data?.title??owner.id,120)}:null},chain,waitingOn:waitingOn.slice(0,10),nextSteps:nextSteps.slice(0,3)},
  refs:collector.refList(),basis:collector.basisList(),
  actions:['open-subject','save-as-judgment'],
 };
}

/* ── 组装、预览与保存 ────────────────────────────────────────────────────── */

function finalizeView({template,subject,params,title,content,refs,basis,actions,now}){
 const generatedAt=localIso(now);
 return {
  kind:'view',
  title:clampText(title,500),
  template,
  subject:{id:subject.id,kind:subject.kind,revision:subject.revision},
  params,
  dataRefs:normalizeDataRefs(refs),
  basis:normalizeBasis(basis),
  generatedAt,
  origin:'ai',
  state:'fresh',
  actions:[...actions],
  // 预览专用：只给渲染器用；saveViewDraft 落库前会剥掉（保存的是定义，不是渲染快照）。
  content:{...content,title:clampText(title,500),dataAt:generatedAt,subject:{id:subject.id,kind:subject.kind,title:clampText(subject.data?.title??subject.id,300),revision:subject.revision}},
 };
}

/** 生成一张视图（预览，不落库）。 */
export function buildView({store,ctx,template,subjectId,params,now=new Date()}){
 if(typeof template!=='string')fail('INVALID','需要模板（template）：'+VIEW_TEMPLATES.join(' / '));
 const normalized=normalizeTemplateParams(template.trim(),params);
 let built,subject;
 if(template==='compare-table'){
  subject=null;
  const sources=normalized.subjectIds.map(id=>{
   const item=store.get(ctx,id);
   if(!item||item.archived)fail('REFERENCE','引用的对象不可用：'+id);
   return item;
  });
  built=buildCompareTable(store,ctx,sources,normalized,now);
  subject=sources[0];
 }else{
  subject=loadSubject(store,ctx,subjectId,template);
  built=template==='risk-matrix'?buildRiskMatrix(store,ctx,subject,normalized,now)
   :template==='timeline'?buildTimeline(store,ctx,subject,normalized,now)
   :buildBlocker(store,ctx,subject,normalized,now);
 }
 return finalizeView({template,subject,params:normalized,now,...built});
}

/** 预览入口：`{template,subjectId,params}` 生成；或 `{viewId}` 打开保存过的视图（按当前数据重算 + stale 判定）。 */
export function buildViewPreview({store,ctx,template,subjectId,params,viewId,now=new Date()}){
 if(viewId!==undefined){
  if(typeof viewId!=='string'||!viewId.trim())fail('INVALID','viewId 无效');
  const saved=store.get(ctx,viewId.trim());
  if(!saved||saved.archived||saved.kind!=='view')fail('NOT_FOUND','视图不存在或已归档');
  const definition=validateViewDefinition(saved.data);
  const stale=staleForView(store,ctx,saved.data);
  const rebuilt=buildView({store,ctx,template:definition.template,subjectId:definition.subject.id,params:definition.params,now});
  return {
   ...rebuilt,
   title:definition.title,
   ...(definition.description===undefined?{}:{description:definition.description}),
   params:definition.params,
   dataRefs:definition.dataRefs,
   basis:definition.basis,
   generatedAt:definition.generatedAt,
   origin:definition.origin??rebuilt.origin,
   state:stale.state,
   actions:definition.actions,
   ...(definition.savedAs===undefined?{}:{savedAs:definition.savedAs}),
   ...(definition.analysis===undefined?{}:{analysis:definition.analysis}),
   content:{...rebuilt.content,title:definition.title,dataAt:localIso(now),subject:{id:definition.subject.id,kind:definition.subject.kind,title:clampText(rebuilt.content?.subject?.title??definition.subject.id,300),revision:definition.subject.revision}},
  };
 }
 if(typeof template!=='string'||!template.trim())fail('INVALID','需要模板（template）：'+VIEW_TEMPLATES.join(' / '));
 return buildView({store,ctx,template:template.trim(),subjectId,params,now});
}

/** 从预览对象里取出**可落库的定义**（剥掉 content 等渲染期字段）。 */
function definitionFromPreview(view){
 if(!isObject(view))fail('INVALID','视图数据必须是对象');
 if(view.kind!==undefined&&view.kind!=='view')fail('INVALID','只能保存 kind=view 的对象');
 const keys=['title','description','template','subject','params','dataRefs','basis','generatedAt','origin','state','actions','savedAs','analysis'];
 const definition={};
 for(const key of keys)if(view[key]!==undefined)definition[key]=clone(view[key]);
 validateViewDefinition(definition);
 return definition;
}
function normalizeSaveAs(as){
 if(as===undefined||as==='view')return 'view';
 if(as==='judgment'||as==='save-as-judgment')return 'judgment';
 if(as==='brief'||as==='save-as-brief')return 'brief';
 fail('INVALID','保存方式只能是 view / judgment / brief');
}
function judgmentFromView(definition){
 return {title:clampText(definition.title,500),evidence:definition.basis.map(entry=>({...entry})),uncertainty:'由生成视图转存；结论与适用期需要你确认',validFrom:dateOnly(definition.generatedAt)??definition.generatedAt.slice(0,10),status:'checking',origin:'ai'};
}
function summarizeView(definition,content){
 const base='由工作台生成视图转存：「'+clampText(definition.title,120)+'」（模板 '+definition.template+'，依据 '+definition.basis.length+' 条，生成于 '+definition.generatedAt+'）。';
 if(!content||typeof content!=='object')return base;
 if(definition.template==='risk-matrix'&&Array.isArray(content.rows)&&content.counts){
  return base+'共 '+content.rows.length+' 项风险：高 '+content.counts.high+' 项 / 中 '+content.counts.medium+' 项 / 低 '+content.counts.low+' 项。';
 }
 if(definition.template==='timeline'&&Array.isArray(content.items)){
  return base+'时间线共 '+content.items.length+' 个时间点，其中在等 '+(content.waiting?1:0)+' 项。';
 }
 if(definition.template==='compare-table'&&Array.isArray(content.sources)&&content.agreement){
  return base+content.sources.length+' 个来源 × '+(content.dimensions?.length??0)+' 个维度：一致 '+content.agreement.same+' / 分歧 '+content.agreement.diff+' / 未记录 '+content.agreement.missing+' / 需人工读 '+content.agreement.unrated+'。';
 }
 if(definition.template==='blocker'&&Array.isArray(content.nextSteps)){
  return base+'阻塞链 '+content.chain.length+' 环，下一步 '+content.nextSteps.length+' 条。';
 }
 return base;
}
function briefFromView(definition,content){
 return {title:clampText(definition.title,500),content:summarizeView(definition,content),source:'工作台生成视图 · '+definition.template,fetchedAt:new Date(definition.generatedAt).toISOString()};
}

/** 保存视图：只生成 draft（收件箱确认），**不直接 commit**（18 号 §3.3）。
 *  as='view' 只保存视图定义；as='judgment' / 'brief' 在同一 draft 里多生成一条候选对象并把 id 记进 savedAs。 */
export function saveViewDraft({store,ctx,view,as,analysis,source={},idFactory=randomUUID}){
 const mode=normalizeSaveAs(as);
 const definition=definitionFromPreview(view);
 if(analysis!==undefined)definition.analysis=analysis;
 for(const ref of definition.dataRefs){
  const match=REF_PATTERN.exec(ref);
  const item=match?store.get(ctx,match[1]):null;
  if(!item||item.archived)fail('REFERENCE','视图引用的对象不可用：'+(match?match[1]:ref));
 }
 const stale=computeStale(definition.dataRefs,storeLookup(store,ctx));
 const saved={...definition,state:stale.state};
 const changes=[];
 if(mode==='view'){
  changes.push({op:'create',kind:'view',data:saved});
 }else{
  const targetId=idFactory();
  changes.push({op:'create',id:targetId,kind:mode,data:mode==='judgment'?judgmentFromView(saved):briefFromView(saved,view.content)});
  changes.push({op:'create',kind:'view',data:{...saved,savedAs:targetId}});
 }
 const batch=store.writeDraft(ctx,{title:clampText('保存视图 · '+saved.title,500),changes,source},randomUUID());
 return {batch,as:mode};
}

/** 给 Agent 工具用：先生成、再落成 draft（同一入口，不绕过校验）。 */
export function previewAndSaveView({store,ctx,template,subjectId,params,now=new Date(),source={},analysis,idFactory=randomUUID}){
 const view=buildViewPreview({store,ctx,template,subjectId,params,now});
 if(analysis!==undefined)view.analysis=analysis;
 return saveViewDraft({store,ctx,view,as:'view',source,idFactory});
}


/** 编辑器直接改 AI 解读：用户自己的动作，直接提交（不进收件箱），返回最新视图。 */
export function updateViewAnalysis({store,ctx,viewId,revision,analysis,source={}}){
 const item=store.get(ctx,viewId);
 if(!item||item.archived||item.kind!=='view')fail('NOT_FOUND','视图不存在或已归档');
 if(item.revision!==revision)fail('CONFLICT','这张视图在你编辑前刚被改过，请刷新后重试');
 const data={...item.data,analysis};
 validateViewDefinition(data);
 const batch=store.draft(ctx,{title:'更新 AI 解读',changes:[{op:'update',id:viewId,expectedRevision:revision,data}],source});
 const key='view-analysis-'+randomUUID();
 store.commit(ctx,{batchId:batch.id,revision:batch.revision,key});
 return {batch,item:store.get(ctx,viewId)};
}

/* ── 视图导出文档（spec/18 §6：留档另生成文档，带出处与生成时间） ───────── */
const EXPORT_TEMPLATE_LABEL = Object.freeze({'risk-matrix':'风险与证据',timeline:'时间线','compare-table':'材料对比',blocker:'阻塞说明'});
const cell = value => String(value ?? '').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
const dayText = value => typeof value === 'string' && value ? value.slice(0,10) : '未记录';

/** 把一张预览视图导出为 Markdown 文档。纯函数；不落库、不下载。 */
export function exportViewMarkdown(view){
 if(!view||typeof view!=='object')fail('INVALID','导出的视图必须是对象');
 const definition={...view};
 delete definition.content;
 delete definition.kind;
 validateViewDefinition(definition);
 const content=view.content??{};
 const lines=[];
 lines.push('# '+(view.title||'分析视图'),'');
 lines.push('- 模板：'+(EXPORT_TEMPLATE_LABEL[view.template]??view.template));
 lines.push('- 生成时间：'+(view.generatedAt??'未记录'));
 lines.push('- 数据截至：'+(content.dataAt??'未记录'));
 lines.push('- 状态：'+(view.state==='stale'?'依据已变，需复核':'最新'));
 lines.push('- 对象：'+(view.subject?.id??'未记录')+'（'+(view.subject?.kind??'对象')+' @ '+(view.subject?.revision??'?')+'）');
 lines.push('- 依据 '+(view.basis?.length??0)+' 条 · 引用 '+(view.dataRefs?.length??0)+' 条','');
 lines.push('## 依据','');
 (view.basis??[]).forEach((basis,index)=>{
  const quote=typeof basis?.quote==='string'&&basis.quote.trim()?('：'+basis.quote.trim()):'';
  lines.push((index+1)+'. ['+(basis?.kind??'note')+'] '+(basis?.ref??'未记录')+quote);
 });
 if(view.analysis){
  lines.push('','## AI 解读','');
  if(view.analysis.summary)lines.push(view.analysis.summary,'');
  for(const finding of view.analysis.findings??[])lines.push('- ['+finding.ref+'] '+finding.text);
  if(view.analysis.uncertainty)lines.push('','不确定性：'+view.analysis.uncertainty);
 }
 lines.push('','## 内容','');
 if(view.template==='risk-matrix'){
  lines.push('| 记录 | 风险 | 证据强度 | 说明 |');
  lines.push('|---|---|---|---|');
  for(const row of content.rows??[]){
   const evidence=row.evidenceStrength==='strong'?'强':row.evidenceStrength==='medium'?'中':row.evidenceStrength==='weak'?'弱':'未记录';
   lines.push('| '+cell(row.title)+' | '+cell(row.riskLabel??row.risk)+' | '+evidence+'（'+cell(row.evidenceCount??0)+' 条，已验证 '+cell(row.verifiedCount??0)+'） | '+cell(row.reason)+' |');
  }
  if(!(content.rows??[]).length)lines.push('_没有可排到风险矩阵的记录。_');
 }else if(view.template==='timeline'){
  for(const item of content.items??[])lines.push('- '+dayText(item.at)+' · '+cell(item.title)+'（'+cell(item.stateLabel??item.state)+'）');
  if(!(content.items??[]).length)lines.push('_没有可排到时间线的记录。_');
 }else if(view.template==='compare-table'){
  const sources=content.sources??[];const dimensions=content.dimensions??[];const matrix=content.matrix??[];
  lines.push('| 维度 | '+sources.map(s=>cell(s.title)).join(' | ')+' |');
  lines.push('|---|'+sources.map(()=>'---').join('|')+'|');
  for(const dim of dimensions){
   const row=matrix.find(entry=>entry.id===dim.id);
   lines.push('| '+cell(dim.label)+' | '+(row?.cells??[]).map(c=>cell(c.value)+'（'+cell(c.status)+'）').join(' | ')+' |');
  }
  if(!dimensions.length)lines.push('_没有可对比的维度。_');
 }else if(view.template==='blocker'){
  lines.push('### 卡在哪','',(content.chain??[]).map(item=>'- '+cell(item.title)+'（'+cell(item.stateLabel??item.state)+'）'+(item.reason?'：'+cell(item.reason):'')).join('\n')||'_未记录_','');
  lines.push('### 在等谁','',(content.waitingOn??[]).map(item=>'- '+cell(item.title)).join('\n')||'_未记录_','');
  lines.push('### 下一步','',(content.nextSteps??[]).map(item=>'- '+cell(item.label)+(item.reason?'（'+cell(item.reason)+'）':'')).join('\n')||'_未记录_');
 }
 lines.push('','---','由个人工作台按 view v1 定义生成；定义可复现，视图不是证据。');
 const safe=(view.title||'分析视图').replace(/[\\/:*?"<>|]/g,'-').slice(0,60);
 return {filename:safe+'-'+dayText(view.generatedAt)+'.md',markdown:lines.join('\n')+'\n'};
}
