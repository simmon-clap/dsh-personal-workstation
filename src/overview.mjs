export function eventOrder(a,b){const at=Date.parse(a.data.startDate??''),bt=Date.parse(b.data.startDate??'');const x=Number.isFinite(at)?at:Infinity,y=Number.isFinite(bt)?bt:Infinity;return (x===y?0:x<y?-1:1)||a.id.localeCompare(b.id);}
export function overview(store,ctx,{execution=null}={}){
 store.context(ctx);
 const scope=store.scopeClause(ctx);
 const rows=store.db.prepare('SELECT id FROM entities WHERE workspace IN '+scope.sql+' AND archived=0').all(...scope.params);
 const items=rows.map(r=>store.get(ctx,r.id));const projects=items.filter(e=>e.kind==='project'),tasks=items.filter(e=>e.kind==='task');
 const links=new Map();for(const e of items){if(!e.data.projectId)continue;let stats=links.get(e.data.projectId);if(!stats){stats={tasks:0,materials:0,waiting:0};links.set(e.data.projectId,stats)}if(e.kind==='task'){stats.tasks++;if(e.data.status==='waiting')stats.waiting++}if(e.kind==='artifact')stats.materials++;}
 const projectRows=projects.map(p=>{const deliveries=p.data.deliverables??[];const stats=links.get(p.id)??{tasks:0,materials:0,waiting:0};const completed=deliveries.filter(d=>d.done).length;return {id:p.id,title:p.data.title,stage:p.data.stage||'待规划',completed,total:deliveries.length,percent:deliveries.length?Math.round(100*completed/deliveries.length):null,...stats};});
 const counts={};for(const t of tasks){const status=t.data.status??'todo';counts[status]=(counts[status]??0)+1;}
 const pending=store.db.prepare("SELECT count(*) AS n FROM batches WHERE workspace=? AND status='draft'").get(store.batchScopes()[0]).n;
 // 光有数字不够：用户 2026-10-16 明确要求"点开数字要**弹出对应的列表**，不要跳走"。
 // 所以这里连清单一起返回（id + 标题），界面才有东西可弹。
 const pendingList=store.db.prepare("SELECT id,json_extract(body,'$.title') AS title FROM batches WHERE workspace=? AND status='draft' ORDER BY rowid DESC LIMIT 50").all(store.batchScopes()[0]);
 // 待整理：已落库但**尚未归属任何项目**的资料记录（不含归档）。这是一个可推导、定义明确的状态，
 // 不是虚构的状态机——界面必须同时说明它数的是什么。
 const unorganized=items.filter(e=>e.kind==='artifact'&&!e.data.projectId).length;
 const unorganizedTopics=items.filter(e=>e.kind==='topic'&&!e.data.projectId).length;
 return {unorganized:{materials:unorganized,topics:unorganizedTopics,total:unorganized+unorganizedTopics},projectCount:projects.length,taskCount:tasks.length,completedDeliveries:projectRows.reduce((s,p)=>s+p.completed,0),totalDeliveries:projectRows.reduce((s,p)=>s+p.total,0),pendingBatches:pending,pendingList:Array.isArray(pendingList)?pendingList:[],taskStatus:counts,projects:projectRows,events:items.filter(e=>e.kind==='event').sort(eventOrder).slice(0,10).map(e=>({id:e.id,title:e.data.title,startDate:e.data.startDate??null,location:e.data.location??null})),execution:execution??{connected:false,reason:'执行器未启用'}};
}
