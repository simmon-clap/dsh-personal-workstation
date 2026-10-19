import { DatabaseSync } from 'node:sqlite';
import {ROOT_SCOPE,scopeForKind,readScopes,isWorkspaceScopedKind} from './scope.mjs';
import { validateData, validateDependencies, validateProposal } from './validation.mjs';
import { linkBatchChanges } from './batch-link.mjs';
import { randomUUID, createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new DomainError(code, message); };
const kinds = new Set(['project','task','organization','person','topic','artifact','event','relation','layout','proposal','memoryRef','brief','judgment','view']);
const copy = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const forbidden = new Set(['__proto__','prototype','constructor']);
function safe(value, depth=0) {
  if (depth>16) fail('INVALID','数据嵌套过深');
  if (typeof value==='number'&&!Number.isFinite(value)) fail('INVALID','数字无效');
  if (Array.isArray(value)) value.forEach(v=>safe(v,depth+1));
  else if(value&&typeof value==='object') for(const [k,v] of Object.entries(value)){if(forbidden.has(k))fail('INVALID','保留字段');safe(v,depth+1);}
}
function text(v,label){if(typeof v!=='string'||!v.trim()||v.length>500)fail('INVALID',label+'无效');return v;}

/** Context is supplied by the adapter, never copied from model payload. */
export class WorkstationStore {
  constructor(filename) {
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(workspace TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,author TEXT,at TEXT,PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS batches(workspace TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS receipts(workspace TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,key));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,workspace TEXT NOT NULL,actor TEXT NOT NULL,event TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tombstones(workspace TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL,PRIMARY KEY(workspace,id));`);
    this.migrateScopes();
    // 老库补列（幂等）：新建的表已经带上这两列，老库需要补 —— SQLite 没有 ADD COLUMN IF NOT EXISTS，
    // 所以放到 JS 里逐条 try/catch（与 migrateScopes 同路数）。
    for (const column of ['author TEXT', 'at TEXT']) {
      try { this.db.exec(`ALTER TABLE entities ADD COLUMN ${column}`); } catch { /* 已经有了 */ }
    }
  }
  /** 一次性迁移（幂等）：把所有业务数据从各工作区搬到根作用域（v3：工作台不再随工作区变化）。
   *  规则见 scope.mjs；重复执行不会丢数据：先 INSERT OR REPLACE 再删旧行。 */
  migrateScopes(){
   const globalKinds="1=1";   // v3：全部类型都全局（资料也跟项目走，不再按工作区隔离）
   try{
    this.db.exec(`BEGIN IMMEDIATE;
      INSERT OR REPLACE INTO entities(workspace,id,kind,revision,data,archived)
        SELECT '${ROOT_SCOPE}',id,kind,revision,data,archived FROM entities WHERE workspace<>'${ROOT_SCOPE}' AND ${globalKinds};
      DELETE FROM entities WHERE workspace<>'${ROOT_SCOPE}' AND ${globalKinds};
      INSERT OR REPLACE INTO batches(workspace,id,revision,status,body)
        SELECT '${ROOT_SCOPE}',id,revision,status,body FROM batches WHERE workspace<>'${ROOT_SCOPE}';
      DELETE FROM batches WHERE workspace<>'${ROOT_SCOPE}';
      INSERT OR REPLACE INTO receipts(workspace,key,hash,body)
        SELECT '${ROOT_SCOPE}',key,hash,body FROM receipts WHERE workspace<>'${ROOT_SCOPE}';
      DELETE FROM receipts WHERE workspace<>'${ROOT_SCOPE}';
      COMMIT;`);
   }catch(error){try{this.db.exec('ROLLBACK')}catch{}throw error}
  }
  close(){this.db.close();}
  context(ctx,write=false){if(!ctx||!ctx.workspace||!ctx.actor)fail('UNAUTHORIZED','缺少可信上下文');if(write&&!ctx.canWrite)fail('FORBIDDEN','当前上下文只读');return ctx.workspace;}
  log(ctx,event,body){this.db.prepare('INSERT INTO audit(workspace,actor,event,body,at) VALUES(?,?,?,?,?)').run(ctx.workspace,ctx.actor,event,JSON.stringify(body),new Date().toISOString());}
  // 读取跨作用域：全局对象在 root，材料在当前工作区——先 root 再工作区。
  get(ctx,id){this.context(ctx);for(const scope of readScopes(ctx)){const r=this.db.prepare('SELECT * FROM entities WHERE workspace=? AND id=?').get(scope,id);if(r)return {id:r.id,kind:r.kind,revision:r.revision,archived:!!r.archived,author:r.author??null,at:r.at??null,data:JSON.parse(r.data)}}return null;}
  /** 读取作用域：给需要自写 SQL 的模块（graph/overview）用，保证与 list 同口径。 */
  scopesFor(ctx,kind){this.context(ctx);return kind?(isWorkspaceScopedKind(kind)?[ctx.workspace]:[ROOT_SCOPE]):readScopes(ctx);}
  /** 批次（收件箱）永远在根作用域。 */
  batchScopes(){return [ROOT_SCOPE];}
  /** 拼出 IN (?,?) 片段与参数，避免各模块自己拼错。 */
  scopeClause(ctx,kind){const scopes=this.scopesFor(ctx,kind);return {sql:'('+scopes.map(()=>'?').join(',')+')',params:scopes};}
  /** 对象实际所在的作用域（写回/删除要用它，不能猜）。 */
  scopeOf(ctx,id){this.context(ctx);for(const scope of readScopes(ctx)){const row=this.db.prepare('SELECT workspace FROM entities WHERE workspace=? AND id=?').get(scope,id);if(row)return row.workspace}return scopeForKind(ctx,'project');}
  list(ctx,{kind,projectId,executionTarget,status,query='',includeArchived=false,limit=200,offset=0}={}){const w=this.context(ctx);if(status!==undefined&&(kind!=='task'||!['todo','waiting','in_progress','done','cancelled'].includes(status)))fail('INVALID','任务业务状态筛选无效');if(projectId!==undefined)text(projectId,'项目ID');if(executionTarget!==undefined){text(executionTarget,'执行目标');if(kind!=='task')fail('INVALID','执行目标筛选仅用于任务');}if(typeof query!=='string'||query.length>200)fail('INVALID','名称搜索无效');if(typeof includeArchived!=='boolean')fail('INVALID','includeArchived 必须为布尔值');if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(offset)||offset<0)fail('INVALID','翻页参数无效');// 作用域：全局类型只在 root；材料只在当前工作区；不指定类型时并集（材料＋全局都看得到）。
 const scopes=kind?(isWorkspaceScopedKind(kind)?[ctx.workspace]:[ROOT_SCOPE]):readScopes(ctx);
 const placeholders=scopes.map(()=>'?').join(',');
 return this.db.prepare('SELECT id FROM entities WHERE workspace IN ('+placeholders+') AND (? IS NULL OR kind=?) AND (? IS NULL OR json_extract(data,\'$.projectId\')=?) AND (? IS NULL OR COALESCE(NULLIF(json_extract(data,\'$.executionTarget\'),\'\'),\'local\')=?) AND (? IS NULL OR json_extract(data,\'$.status\')=?) AND (? OR archived=0) AND instr(lower(COALESCE(json_extract(data,\'$.title\'),\'\')),lower(?))>0 ORDER BY id LIMIT ? OFFSET ?').all(...scopes,kind??null,kind??null,projectId??null,projectId??null,executionTarget??null,executionTarget??null,status??null,status??null,Number(includeArchived),query.trim(),limit,offset).map(r=>this.get(ctx,r.id));}
  // 批次与回执落在根作用域：收件箱是全局的，在哪都能确认与撤销。
  batch(ctx,id){this.context(ctx);const r=this.db.prepare('SELECT * FROM batches WHERE workspace=? AND id=?').get(ROOT_SCOPE,id);return r?{id:r.id,revision:r.revision,status:r.status,...JSON.parse(r.body)}:null;}
  draft(ctx,input,id=randomUUID(),expected){this.context(ctx,true);this.db.exec('BEGIN IMMEDIATE');try{const result=this.writeDraft(ctx,input,id,expected);this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  writeDraft(ctx,{title,changes,source={},proposal},id,expected){this.context(ctx,true);text(title,'这次改动标题');if(!Array.isArray(changes)||!changes.length||changes.length>100)fail('INVALID','变更数量应为1–100');safe(changes);safe(source);if(proposal!==undefined)safe(proposal);if(JSON.stringify({changes,source,proposal}).length>1000000)fail('INVALID','这次改动过大');text(id,'这次改动ID');const old=this.batch(ctx,id);if(!old&&expected!==undefined)fail('CONFLICT','要修改的这次改动不存在');if(old&&(old.status!=='draft'||old.revision!==expected))fail('CONFLICT','这次改动版本已变化');const normalized=changes.map(c=>{if(!['create','update','archive','restore','delete'].includes(c.op))fail('INVALID','未知操作');const id=c.id??(c.op==='create'?randomUUID():null);text(id,'对象ID');if(c.op==='create'&&!kinds.has(c.kind))fail('INVALID','未知对象类型');if(c.op!=='create'&&(!Number.isInteger(c.expectedRevision)||c.expectedRevision<1))fail('INVALID','必须指定对象版本');// 归档、恢复、删除都不需要重复提交整份数据：服务端用库里已有的内容。
  if(!['archive','restore','delete'].includes(c.op)&&(!c.data||Array.isArray(c.data)||typeof c.data!=='object'))fail('INVALID','必须提供对象数据');
  // 逐字段来源：只允许给本变更实际改动的字段加注来源，缺省即「未标注」，不得伪造。
  if(c.sources!==undefined){const sources=c.sources;if(!sources||typeof sources!=='object'||Array.isArray(sources))fail('INVALID','字段来源必须是对象');const keys=Object.keys(sources);if(keys.length>50)fail('INVALID','字段来源条目过多');for(const key of keys){if(!c.data||!Object.hasOwn(c.data,key))fail('INVALID','字段来源只能标注本次变更包含的字段：'+key);const value=sources[key];if(typeof value!=='string'||!value.trim()||value.length>200)fail('INVALID','字段来源说明必须为 1–200 字：'+key);}}
  return {...copy(c),id};});
  // 同批新建「1 个项目 + 材料」时自动把材料挂到该项目（体检 A2）：用户真实痛点是材料建好了却没归属，
  // 只能事后单独补一批。规则与边界见 batch-link.mjs：不猜（0 或 ≥2 个新建项目时一个字段都不改）、
  // 不覆盖材料自己带的 projectId，并在 sources 里如实标注为自动关联。
  // 只在**本批第一次生成草稿**时应用：否则用户在预览里改回「未归属」后，下一次修订又会被自动挂回去，
  // 那样"可撤销"就是假的。后续修订（含收件箱里的一键指定）一律以用户/Agent 给的内容为准。
  const linked=old?{changes:normalized,linked:[]}:linkBatchChanges(normalized);const batchChanges=linked.changes;
  if(new Set(batchChanges.map(c=>c.id)).size!==batchChanges.length)fail('INVALID','同这次改动每个对象只能出现一次');const now=new Date().toISOString();// 建议的说明：改草稿时若没带 proposal 就保留原来的（改内容不该把回应与理由抹掉）。
  const nextProposal=proposal===undefined?(old?.proposal):validateProposal(proposal);
  const body={title,changes:batchChanges,source:copy(source),...(nextProposal?{proposal:nextProposal}:{}),author:ctx.actor,createdAt:old?old.createdAt??null:now,updatedAt:now};this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(ROOT_SCOPE,id,(old?.revision??0)+1,'draft',JSON.stringify(body));this.log(ctx,'draft',{id});return this.batch(ctx,id);}
  /** 已回应的建议（新的在前）。用于：采纳情况统计、以及"被否决的不复活"时先查一遍。 */
  proposalHistory(ctx,{limit=20}={}){
   this.context(ctx);
   if(!Number.isInteger(limit)||limit<1||limit>200)fail('INVALID','条数无效');
   const rows=this.db.prepare('SELECT id,status,body FROM batches WHERE workspace=? ORDER BY rowid DESC LIMIT ?').all(ROOT_SCOPE,limit*5);
   return rows.map(row=>({id:row.id,status:row.status,...JSON.parse(row.body)})).filter(batch=>batch.proposal&&batch.proposal.decision!=='undecided')
    .slice(0,limit)
    .map(batch=>({id:batch.id,title:batch.title,status:batch.status,decision:batch.proposal.decision,reason:batch.proposal.reason??'',basedOn:batch.proposal.basedOn??[],decidedAt:batch.proposal.decidedAt??null}));
  }
  /** 建议闭环的学习面（W3-D）：最近回应的采纳率，以及和前一段相比的变化。
   *  只统计**已经回应过**的建议；没回应的不参与，不把沉默算成采纳。 */
  proposalStats(ctx,{limit=40}={}){
   this.context(ctx);
   if(!Number.isInteger(limit)||limit<4||limit>200)fail('INVALID','统计条数无效');
   const rows=this.db.prepare('SELECT id,status,body FROM batches WHERE workspace=? ORDER BY rowid DESC LIMIT ?').all(ROOT_SCOPE,limit*5);
   const decided=rows.map(row=>({id:row.id,status:row.status,...JSON.parse(row.body)})).filter(batch=>batch.proposal&&['accepted','rewritten','rejected'].includes(batch.proposal.decision))
    .sort((left,right)=>String(left.proposal.decidedAt??'').localeCompare(String(right.proposal.decidedAt??'')));
   const count=items=>{
    const tally={accepted:0,rewritten:0,rejected:0};
    for(const item of items)tally[item.proposal.decision]+=1;
    const total=items.length;
    const adopted=tally.accepted+tally.rewritten;
    return {...tally,total,rate:total?Math.round(adopted/total*1000)/10:null};
   };
   const half=Math.max(1,Math.floor(Math.min(10,decided.length)/2));
   const recent=decided.slice(-Math.min(10,decided.length));
   const previous=decided.slice(-Math.min(20,decided.length),-Math.min(10,decided.length));
   const current=count(recent),past=count(previous);
   return {current,previous:past,deltaPoints:current.rate!==null&&past.rate!==null?Math.round((current.rate-past.rate)*10)/10:null,recentLimit:half*2};
  }
  cancelDraft(ctx,id,revision){this.context(ctx,true);this.db.exec('BEGIN IMMEDIATE');try{const b=this.batch(ctx,id);if(!b||b.status!=='draft'||b.revision!==revision)fail('CONFLICT','这次改动的状态或版本已变化');this.db.prepare("UPDATE batches SET status='cancelled',revision=revision+1,body=json_set(body,'$.updatedAt',?) WHERE workspace=? AND id=?").run(new Date().toISOString(),ROOT_SCOPE,id);this.log(ctx,'cancel_draft',{id,revision});const result=this.batch(ctx,id);this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  inbox(ctx,{status,limit=100,offset=0}={}){this.context(ctx);if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)fail('INVALID','翻页参数无效');return this.db.prepare('SELECT id FROM batches WHERE workspace=? AND (? IS NULL OR status=?) ORDER BY json_extract(body,\'$.updatedAt\') DESC, rowid DESC LIMIT ? OFFSET ?').all(ROOT_SCOPE,status??null,status??null,limit,offset).map(r=>this.batch(ctx,r.id));}
  receipt(ctx,key){this.context(ctx);const r=this.db.prepare('SELECT body FROM receipts WHERE workspace=? AND key=?').get(ROOT_SCOPE,key);return r?JSON.parse(r.body):null;}
  /** 找出仍引用该对象的记录（用于删除前检查）。扫描的是真实的引用字段，不用猜测。 */
  references(ctx,id){
   this.context(ctx);
   const fields=['projectId','partnerId','ownerId','organizationId','deliverableId','from','to','memoryRefId'];
   const arrays=['dependsOn','attendees','sourceRefs','tags','taskIds'];
   const out=[];
   const scopes=readScopes(ctx);
   const placeholders=scopes.map(()=>'?').join(',');
   for(const row of this.db.prepare('SELECT id FROM entities WHERE workspace IN ('+placeholders+') AND archived=0').all(...scopes)){
    if(row.id===id)continue;
    const item=this.get(ctx,row.id);
    for(const field of fields)if(item.data?.[field]===id)out.push({id:item.id,kind:item.kind,title:item.data?.title??item.id,field});
    for(const field of arrays)if(Array.isArray(item.data?.[field])&&item.data[field].includes(id))out.push({id:item.id,kind:item.kind,title:item.data?.title??item.id,field});
   }
   return out;
  }
  preview(ctx,id){const b=this.batch(ctx,id);if(!b)fail('NOT_FOUND','这次改动不存在');if(b.status==='committed'){const row=this.db.prepare("SELECT body FROM receipts WHERE workspace=? AND json_extract(body,'$.batchId')=?").get(ROOT_SCOPE,id);if(!row)fail('INTERNAL','记录不完整：找不到这次改动的记录编号');const receipt=JSON.parse(row.body);// 已提交批次的差异同样只能放 JSON 无损的值：缺失的快照写 null（"此前不存在"），
// archivedData 只在真的归档时出现，不再挂一个值为 undefined 的键。
return {...b,receipt,diff:b.changes.map((c,i)=>{const snapshot=receipt.after[i]??null;return {id:c.id,kind:c.kind??receipt.before[i]?.kind??this.get(ctx,c.id)?.kind??null,op:c.op,before:receipt.before[i]??null,after:snapshot?.archived?null:snapshot?.data??null,...(snapshot?.archived?{archivedData:snapshot.data}:{})}})};}const conflicts=b.changes.flatMap(c=>{const current=this.get(ctx,c.id);const stale=c.op==='create'?!!current:(!current||current.revision!==c.expectedRevision||(c.op==='restore'?!current.archived:c.op==='delete'?false:current.archived));return stale?[{id:c.id,expectedRevision:c.expectedRevision??null,currentRevision:current?.revision??null,reason:'对象版本或归档状态已变化'}]:[]});
  // 删除前先列出引用方：让用户先看到"删了会影响谁"，而不是删完才发现关系断了。
// 差异项只放 JSON 无损的值（宿主对工具返回值做无损快照，任何嵌套 undefined 都会拒收整次调用）：
// · before：库里没有该对象时是 null，"此前不存在"用 null 表达，不用 undefined。
// · after：新建/修改取变更数据；恢复复用库里内容（变更里不带 data），归档/删除为 null。
// · archivedData：只在 op==='archive' 时存在；其余 op 之前会写 undefined，正是 preview 被拒的原因。
  const references=b.changes.filter(c=>c.op==='delete').flatMap(c=>this.references(ctx,c.id).map(ref=>({...ref,target:c.id,targetTitle:this.get(ctx,c.id)?.data?.title??c.id})));const validationErrors=b.changes.flatMap(c=>{
  // **restore 也不带数据**（它从库里把对象恢复回来），原来没被排除 →
  // `validateData(kind, undefined)` 报「对象类型或数据无效」→ 整批被判「需补充/冲突」→
  // 在「待确认」里根本看不见，用户以为"点不动"（2026-10-16 实测到的真 bug）。
  if(('archive'===c.op||'delete'===c.op||'restore'===c.op)&&c.data===undefined)return [];const kind=c.op==='create'?c.kind:this.get(ctx,c.id)?.kind;if(!kind)return [];try{validateData(kind,c.data);if(kind!=='layout'&&c.op!=='archive')text(c.data.title,'标题');return [];}catch(e){if(e.code!=='INVALID')throw e;return [{id:c.id,code:e.code,message:e.message}];}});return {...b,conflicts,validationErrors,references,diff:b.changes.map(c=>{const current=this.get(ctx,c.id);const after=c.op==='archive'||c.op==='delete'?null:c.op==='restore'?current?.data??null:c.data;return {id:c.id,kind:c.kind??current?.kind??null,op:c.op,before:current,after,...(c.op==='archive'?{archivedData:c.data??current?.data??null}:{}),sources:c.sources?copy(c.sources):null}})};}
  undoDraft(ctx,key){this.context(ctx,true);this.db.exec('BEGIN IMMEDIATE');try{const result=this.writeUndoDraft(ctx,key);this.db.exec('COMMIT');return result}catch(error){this.db.exec('ROLLBACK');throw error}}
  writeUndoDraft(ctx,key){const r=this.receipt(ctx,key);if(!r)fail('NOT_FOUND','记录编号不存在');const changes=r.after.map((after,i)=>{
   const before=r.before[i];
   // 删除的逆操作是重建：对象已经不在库里，用回执里的 before 数据还原。
   if(after?.deleted){if(!before)fail('CONFLICT','记录编号缺少删除前的数据，不能撤销');if(this.get(ctx,after.id))fail('CONFLICT','该对象已重新存在，不能重复撤销');return {op:'create',id:after.id,kind:before.kind,data:before.data};}
   const now=this.get(ctx,after.id);
   if(!now||now.revision!==after.revision)fail('CONFLICT','对象已被后续修改，不能直接撤销');
   return before?{op:before.archived?'archive':after.archived?'restore':'update',id:after.id,expectedRevision:now.revision,data:before.data}:{op:'archive',id:after.id,expectedRevision:now.revision};
  });const existing=this.db.prepare("SELECT id FROM batches WHERE workspace=? AND status='draft' AND json_extract(body,'$.source.undoReceipt')=? ORDER BY rowid DESC").all(ROOT_SCOPE,r.id);for(const row of existing){const draft=this.batch(ctx,row.id);if(JSON.stringify(draft.changes)===JSON.stringify(changes))return draft}return this.writeDraft(ctx,{title:'撤销这次改动',changes,source:{undoReceipt:r.id}},randomUUID());}
  // 材料↔任务是**多对多**（用户明确）：taskIds 每一项都必须指向同一工作区内一个未归档的任务，
  // 由 resolve 在本工作区里查；同时 taskIds 进了 references()，所以任务被材料引用时删除/归档会被拦下。
  validateEntity(entity,resolve){validateData(entity.kind,entity.data);if(!entity.data||typeof entity.data!=='object')fail('INVALID','对象无效');if(entity.kind!=='layout')text(entity.data.title,'标题');if(entity.data.projectId){const p=resolve(entity.data.projectId);if(!p||p.archived||p.kind!=='project')fail('REFERENCE','所属项目不可用');}for(const [field,kind] of [['ownerId','person'],['partnerId','organization'],['organizationId','organization']])if(entity.data[field]){const ref=resolve(entity.data[field]);if(!ref||ref.archived||ref.kind!==kind)fail('REFERENCE',field+'引用无效');}if(entity.kind==='task')for(const id of entity.data.dependsOn??[]){const ref=resolve(id);if(id===entity.id||!ref||ref.archived||ref.kind!=='task')fail('REFERENCE','任务依赖无效');}if(entity.kind==='artifact')for(const id of entity.data.taskIds??[]){const ref=resolve(id);if(!ref||ref.archived||ref.kind!=='task')fail('REFERENCE','关联任务不可用：'+id);}if(entity.kind==='relation'){for(const key of ['from','to']){const ref=resolve(entity.data[key]);if(!ref||ref.archived)fail('REFERENCE','关系端点不可用');}if(!['suggested','confirmed','rejected','stale'].includes(entity.data.status))fail('INVALID','关系状态无效');if(!entity.data.evidence)fail('INVALID','关系缺少依据');}if(entity.kind==='task'&&entity.data.execution)fail('EXECUTION_OWNED','执行状态只能由执行器适配器更新');
  // 生成视图只引用真实、未归档的对象（18 号 §3.2 / §5）；revision 不要求等于当前值：
  // 保存下来的是**定义**，之后 revision 变了由 stale 标记，而不是保存失败。
  if(entity.kind==='view'){
   if(!Array.isArray(entity.data.dataRefs)||!entity.data.dataRefs.length)fail('INVALID','视图至少需要一条数据引用');
   for(const ref of entity.data.dataRefs){
    const match=/^([^@]{1,200})@([1-9]\d*)$/.exec(String(ref));
    if(!match)fail('INVALID','视图数据引用必须为「对象ID@版本」');
    const target=resolve(match[1]);
    if(!target||target.archived)fail('REFERENCE','视图引用的对象不可用：'+match[1]);
   }
  }}
  commit(ctx,{batchId,revision,key}){this.context(ctx,true);text(key,'同一次请求');const hash=digest({batchId,revision});this.db.exec('BEGIN IMMEDIATE');try{const prior=this.db.prepare('SELECT * FROM receipts WHERE workspace=? AND key=?').get(ROOT_SCOPE,key);if(prior){if(prior.hash!==hash)fail('IDEMPOTENCY','同一同一次请求不能用于不同请求');this.db.exec('COMMIT');return JSON.parse(prior.body);}const b=this.batch(ctx,batchId);if(!b||b.status!=='draft'||b.revision!==revision)fail('CONFLICT','这次改动不存在、已经生效，或版本过期');
   // 「为什么这么建议」的依据必须真实存在：basedOn 只能指向同一工作区里未归档的判断。
   if(b.proposal?.basedOn?.length){for(const id of b.proposal.basedOn){const ref=this.get(ctx,id);if(!ref||ref.archived||ref.kind!=='judgment')fail('REFERENCE','建议参考的判断不可用：'+id);}}const pending=new Map(),before=[];for(const c of b.changes){const old=this.get(ctx,c.id);before.push(old);if(c.op==='create'){if(old)fail('CONFLICT','对象已存在');pending.set(c.id,{id:c.id,kind:c.kind,revision:1,archived:false,data:copy(c.data)});}else{if(!old||old.revision!==c.expectedRevision||(c.op==='restore'?!old.archived:old.archived))fail('CONFLICT','这条内容在你操作前刚被改过 —— 这次改动已经过期，需要重新生成后再决定');if(c.op==='archive'&&c.data!==undefined)validateData(old.kind,c.data);pending.set(c.id,{...old,revision:old.revision+1,archived:c.op==='archive',deleted:c.op==='delete',data:['archive','restore','delete'].includes(c.op)&&c.data===undefined?old.data:c.op==='delete'?old.data:copy(c.data)});}}const resolve=id=>pending.get(id)??this.get(ctx,id);// 校验集合必须按**作用域并集**取：全局对象在 root、材料在工作区，漏掉任一边都会让引用校验失效
 // （实测：漏掉后"归档仍被引用的项目"不再被拦，是这次作用域改造踩到的真回归）。
 const validationScopes=this.scopeClause(ctx);
 const all=new Map(this.db.prepare('SELECT id FROM entities WHERE workspace IN '+validationScopes.sql+' AND archived=0').all(...validationScopes.params).map(r=>[r.id,this.get(ctx,r.id)]));for(const [id,e] of pending)all.set(id,e);for(const e of all.values())if(!e.archived)this.validateEntity(e,resolve);validateDependencies(all.values());const removed=[...pending.values()].filter(e=>e.deleted);
for(const e of removed){
 // 删除前再查一次引用：预览时提示过，但提交前必须硬拦，避免出现悬空关系。
 const refs=this.references(ctx,e.id);
 if(refs.length)fail('INVALID','「'+(e.data?.title??e.id)+'」仍被 '+refs.length+' 个对象引用，请先解除引用或改为归档：'+refs.slice(0,3).map(r=>r.title+'（'+r.field+'）').join('、'));
 // 墓碑（宪章 v1.2：**删除必须留墓碑**）。不留的话同步时"这边删了、那边还在"会被当成
 // "对端新增"又拉回来 —— 删了的东西自己复活，而且本地删除永远传不出去。
 this.db.prepare("INSERT INTO tombstones(workspace,id,kind,revision,at) VALUES(?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET revision=excluded.revision,at=excluded.at")
  .run(ROOT_SCOPE,e.id,e.kind??'unknown',Number(e.revision??0)+1,new Date().toISOString());
}
for(const e of pending.values()){
 if(e.deleted)continue;
 // 每条记录写进它该在的作用域：全局类型 → root；材料 → 当前工作区。
 this.db.prepare('INSERT INTO entities(workspace,id,kind,revision,data,archived,author,at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,archived=excluded.archived,author=excluded.author,at=excluded.at').run(scopeForKind(ctx,e.kind),e.id,e.kind,e.revision,JSON.stringify(e.data),Number(e.archived),ctx.actor,new Date().toISOString());
}
// 删除要在它能出现的两个作用域里都删（不能假设它在哪一边）。
for(const e of removed)this.db.prepare("DELETE FROM entities WHERE id=? AND workspace IN ('"+ROOT_SCOPE+"',?)").run(e.id,ctx.workspace);const receipt={id:randomUUID(),batchId,revision,key,status:'committed',at:new Date().toISOString(),before,after:[...pending.values()]};this.db.prepare("UPDATE batches SET status=?,body=json_set(body,'$.updatedAt',?) WHERE workspace=? AND id=?").run('committed',receipt.at,ROOT_SCOPE,batchId);this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(ROOT_SCOPE,key,hash,JSON.stringify(receipt));this.log(ctx,'commit',receipt);this.db.exec('COMMIT');return receipt;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
