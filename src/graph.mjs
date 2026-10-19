import {DomainError} from './store.mjs';
export function searchNodes(store,ctx,{query,limit=30}={}){
 store.context(ctx);if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID','节点搜索参数无效');
 // 作用域与 store.list 同口径：全局对象在 root，材料在当前工作区 → 并集查询。
 const scope=store.scopeClause(ctx);
 const rows=store.db.prepare("SELECT id,kind,revision,json_extract(data,'$.title') AS title FROM entities WHERE workspace IN "+scope.sql+" AND archived=0 AND kind NOT IN ('relation','layout','view') AND instr(lower(json_extract(data,'$.title')),lower(?))>0 ORDER BY id LIMIT ?").all(...scope.params,query.trim(),limit+1);
 return {items:rows.slice(0,limit),hasMore:rows.length>limit};
}
/** 关系依据失效判定：确认时记录的两端版本若与当前不一致（或对象已归档/消失），关系需复核。
 *  只报告状态，不改数据——复核由用户在批次里确认。 */
export function relationStale(relation,byId){
 if(relation.status!=='confirmed'||!Array.isArray(relation.basis)||!relation.basis.length)return null;
 for(const entry of relation.basis){
  const [id,revision]=entry.split('@');if(id!==relation.from&&id!==relation.to)continue;
  const current=byId.get(id);
  if(!current)return '关联对象已不可用：'+id;
  if(!Number.isInteger(current.revision)||current.revision!==Number(revision))return '关联对象已更新：'+(current.data?.title??id);
 }
 return null;
}
/** Bounded workspace projection. No inference is fabricated in the graph layer. */
export function graph(store,ctx,{focus,limit=120,offset=0}={}){
 if(!Number.isInteger(limit)||limit<1||limit>250||!Number.isInteger(offset)||offset<0)throw new DomainError('INVALID','画布翻页参数无效');
 store.context(ctx);
 const scope=store.scopeClause(ctx);
 const rows=store.db.prepare('SELECT id FROM entities WHERE workspace IN '+scope.sql+' AND archived=0 ORDER BY id').all(...scope.params);
 const entities=rows.map(r=>store.get(ctx,r.id)),byId=new Map(entities.map(e=>[e.id,e]));
 const nodes=entities.filter(e=>!['relation','layout','view'].includes(e.kind));
 const edges=[];
 for(const e of entities){
  if(e.data.projectId&&byId.has(e.data.projectId))edges.push({id:'project:'+e.id,from:e.data.projectId,to:e.id,status:'confirmed',title:'项目归属',derived:true});
  for(const [field,title] of [['ownerId','负责人'],['partnerId','合作方'],['organizationId','所属组织']])if(e.data[field]&&byId.has(e.data[field]))edges.push({id:field+':'+e.id,from:e.id,to:e.data[field],status:'confirmed',title,evidence:'对象字段 '+field,derived:true});
  if(e.kind==='task')for(const id of e.data.dependsOn??[])if(byId.has(id))edges.push({id:'depends:'+e.id+':'+id,from:e.id,to:id,status:'confirmed',title:'依赖任务',evidence:'对象字段 dependsOn',derived:true});
  if(e.kind==='relation'&&e.data.status!=='rejected'){
   // 端点缺失的关系不能从列表里消失（否则等于静默失效），标记 missing 供复核。
   const missing=!byId.has(e.data.from)||!byId.has(e.data.to);
   const absent=missing?(byId.has(e.data.from)?e.data.to:e.data.from):null;
   edges.push({id:e.id,revision:e.revision,...e.data,derived:false,missing,stale:missing?'关联对象已不可用：'+absent:relationStale(e.data,byId)});
  }
 }
 // 未处理的推断也要画出来（用户 2026-10-16：「AI 推断的关系必须虚线 + 可点否决，
 // 前提是现有推断，**现在是连虚线都没有**」）。AI 提议的关系还在收件箱里、还没成为业务对象，
 // 所以直接读待决定的批次 —— 否则要"先同意才看得见"，就违背了「先看虚线、再决定」的顺序。
 for(const batch of store.inbox(ctx,{status:'draft',limit:200})){
  for(const change of batch.changes??[]){
   if(change.op!=='create'||change.kind!=='relation')continue;
   const data=change.data??{};
   if(!byId.has(data.from)||!byId.has(data.to))continue;   // 端点不全画不出来，不硬画
   edges.push({
    id:'pending:'+change.id,from:data.from,to:data.to,status:'suggested',
    title:data.title??'待确认的关联',
    evidence:data.evidence??data.reason??'',
    derived:false,pendingBatchId:batch.id,pendingRevision:batch.revision,
   });
  }
 }
 let filtered=nodes;
 if(focus){if(!nodes.some(n=>n.id===focus))throw new DomainError('NOT_FOUND','聚焦对象不存在');const ids=new Set([focus]);for(const e of edges)if(e.from===focus||e.to===focus){ids.add(e.from);ids.add(e.to)}filtered=nodes.filter(n=>ids.has(n.id));filtered.sort((a,b)=>a.id===focus?-1:b.id===focus?1:a.id.localeCompare(b.id));}
 const page=filtered.slice(offset,offset+limit),ids=new Set(page.map(e=>e.id));
 // 独立关系单独返回：端点不在本页（或已缺失）的关系仍须可见可复核，不能因为画不出来就消失。
 const relations=edges.filter(edge=>!edge.derived).map(({derived,...rest})=>rest);
 return {relations,nodes:page.map(e=>({id:e.id,kind:e.kind,revision:e.revision,title:e.data.title,...(['project','task'].includes(e.kind)?{businessStatus:e.data.status??e.data.stage??null,progress:{done:(e.data[e.kind==='project'?'deliverables':'steps']??[]).filter(x=>x.done).length,total:(e.data[e.kind==='project'?'deliverables':'steps']??[]).length},...(e.kind==='project'?{...(e.data.importance?{importance:e.data.importance}:{}),...(e.data.urgency?{urgency:e.data.urgency}:{}),...(e.data.folder?{folder:e.data.folder}:{})}:{})}:{})})),edges:edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),total:filtered.length,nextOffset:offset+limit<filtered.length?offset+limit:null};
}
