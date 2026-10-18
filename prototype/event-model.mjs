// Event dates follow the persisted contract: date-only means all-day.
const pad=n=>String(n).padStart(2,'0');
const dayKey=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
export function eventModel(item){
 const d=item.data,start=d.startDate||'',instant=Date.parse(start),allDay=/^\d{4}-\d{2}-\d{2}$/.test(start),date=new Date(instant);
 const valid=Number.isFinite(instant);
 return {id:item.id,title:d.title||'未命名',allDay,instant:valid?instant:Infinity,dayKey:allDay?start:valid?dayKey(date):null,label:allDay?start+' · 全天':valid?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'未设置时间',location:d.location||'地点未设置'};
}
// All-day dates sort first, then real instants; missing dates last.
export function compareEvents(a,b){const x=eventModel(a),y=eventModel(b);const rank=e=>e.instant===Infinity?(e.allDay?0:2):e.allDay?0:1;const rx=rank(x),ry=rank(y);if(rx!==ry)return rx-ry;if(x.instant!==y.instant)return x.instant<y.instant?-1:1;return x.id.localeCompare(y.id);}
export function eventDayKey(value){return value instanceof Date?dayKey(value):dayKey(new Date(value));}
