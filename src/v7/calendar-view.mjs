import {escapeHtml as esc} from './project-render.mjs';

/** 日历视图（月 / 周），按苹果日历的结构做，配色与圆角走我们自己的 VI（纸上秩序 tokens）。
 *  纯计算部分（月网格、按天分桶、周布局）单独导出，便于单测。 */

const WEEKDAYS=['一','二','三','四','五','六','日'];
const pad=n=>String(n).padStart(2,'0');
export const dayKey=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const parseDay=key=>{const [y,m,d]=key.split('-').map(Number);return new Date(y,m-1,d)};

/** 事件落在哪一天：全天取 startDate 的日期；定时事件取开始那天（跨天事件在月视图只显示开始日）。 */
export function eventDay(event){
 const start=String(event.data?.startDate??'');
 const match=/^(\d{4})-(\d{2})-(\d{2})/.exec(start);
 return match?`${match[1]}-${match[2]}-${match[3]}`:null;
}
export function eventTime(event){
 const start=String(event.data?.startDate??'');
 const match=/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(start);
 return match?`${match[1]}:${match[2]}`:'';
}
export function isAllDay(event){return !/T\d{2}:\d{2}/.test(String(event.data?.startDate??''))}

/** 周一为一周的第一天（与国内习惯一致）。返回 6×7 的日期网格，覆盖整月。 */
export function monthMatrix(year,month){
 const first=new Date(year,month,1);
 const offset=(first.getDay()+6)%7;           // 周一=0
 const start=new Date(year,month,1-offset);
 const weeks=[];
 for(let w=0;w<6;w+=1){
  const row=[];
  for(let d=0;d<7;d+=1)row.push(new Date(start.getFullYear(),start.getMonth(),start.getDate()+w*7+d));
  weeks.push(row);
 }
 return weeks;
}
export function monthTitle(year,month){return `${year} 年 ${month+1} 月`}
/** 把事件按天分桶（同一天内：全天在前，再按时间排序）。 */
export function bucketByDay(items){
 const map=new Map();
 for(const item of items){
  if(item.kind!=='event'||item.archived)continue;
  const key=eventDay(item);if(!key)continue;
  if(!map.has(key))map.set(key,[]);
  map.get(key).push(item);
 }
 for(const list of map.values())list.sort((a,b)=>{
  const allDayDiff=Number(isAllDay(b))-Number(isAllDay(a));
  if(allDayDiff)return allDayDiff;
  return String(a.data.startDate).localeCompare(String(b.data.startDate));
 });
 return map;
}
/** 周视图布局：定时事件换算成 top/height 百分比（一天 24 小时=1440 分钟）。 */
export function weekLayout(items,weekStart){
 const days=[];
 for(let d=0;d<7;d+=1)days.push(new Date(weekStart.getFullYear(),weekStart.getMonth(),weekStart.getDate()+d));
 const keyOf=date=>dayKey(date);
 const allDayByDay=new Map(),timedByDay=new Map();
 for(const item of items){
  if(item.kind!=='event'||item.archived)continue;
  const key=eventDay(item);if(!key)continue;
  const start=String(item.data.startDate??'');
  if(isAllDay(item)){if(!allDayByDay.has(key))allDayByDay.set(key,[]);allDayByDay.get(key).push(item);continue}
  const startMatch=/T(\d{2}):(\d{2})/.exec(start);
  const endMatch=/T(\d{2}):(\d{2})/.exec(String(item.data.endDate??''));
  const startMinutes=startMatch?Number(startMatch[1])*60+Number(startMatch[2]):540;
  let endMinutes=endMatch?Number(endMatch[1])*60+Number(endMatch[2]):startMinutes+60;
  if(endMinutes<=startMinutes)endMinutes=startMinutes+30;
  if(!timedByDay.has(key))timedByDay.set(key,[]);
  timedByDay.get(key).push({...item,top:startMinutes/1440*100,height:Math.max(2.6,(endMinutes-startMinutes)/1440*100),time:eventTime(item)});
 }
 return {
  days:days.map(date=>({key:keyOf(date),date,allDay:allDayByDay.get(keyOf(date))??[],timed:timedByDay.get(keyOf(date))??[]})),
 };
}
export function weekTitle(weekStart){
 const end=new Date(weekStart.getFullYear(),weekStart.getMonth(),weekStart.getDate()+6);
 const sameMonth=weekStart.getMonth()===end.getMonth();
 const left=`${weekStart.getFullYear()} 年 ${weekStart.getMonth()+1} 月 ${weekStart.getDate()} 日`;
 const right=sameMonth?`${end.getDate()} 日`:`${end.getMonth()+1} 月 ${end.getDate()} 日`;
 return `${left} – ${right}`;
}
export function startOfWeek(date){const day=(date.getDay()+6)%7;return new Date(date.getFullYear(),date.getMonth(),date.getDate()-day)}

/** 苹果日历风格的事件条：彩色小条 + 时间 + 标题；已同步/未同步只用不同透明度区分。 */
function chip(item,{showTime=true}={}){
 const time=showTime&&!isAllDay(item)?`<i>${esc(eventTime(item))}</i>`:'';
 const synced=Boolean(item.data?.externalUid);
 const title=item.data?.title??'未命名';
 return `<button class="calchip${isAllDay(item)?' allday':''}${synced?'':' unsynced'}" data-calevent="${esc(item.id)}" title="${esc(title)}（${synced?'已同步到苹果日历':'未同步'}）">${time}<span>${esc(title)}</span></button>`;
}

export function mountCalendar(document,items,{open,region}={}){
 const host=region??document.querySelector('#calbody');
 const state={view:'month',cursor:new Date()};
 const today=dayKey(new Date());
 const buckets=()=>bucketByDay(items);

 function renderMonth(){
  const {cursor}=state;
  const matrix=monthMatrix(cursor.getFullYear(),cursor.getMonth());
  const map=buckets();
  const head=WEEKDAYS.map(name=>`<div class="calhead">${name}</div>`).join('');
  const cells=matrix.flat().map(date=>{
   const key=dayKey(date);
   const list=map.get(key)??[];
   const dim=date.getMonth()!==cursor.getMonth();
   const shown=list.slice(0,3);
   const more=list.length-shown.length;
   return `<div class="calcell${dim?' dim':''}${key===today?' today':''}" data-calday="${key}">
     <span class="caldate">${date.getDate()}</span>
     <div class="callist">${shown.map(item=>chip(item)).join('')}${more>0?`<span class="calmore">还有 ${more} 项</span>`:''}</div>
    </div>`;
  }).join('');
  return `<div class="calgrid">${head}${cells}</div>`;
 }
 function renderWeek(){
  const weekStart=startOfWeek(state.cursor);
  const {days}=weekLayout(items,weekStart);
  const hours=Array.from({length:24},(_,h)=>`<div class="calhour"><span>${pad(h)}:00</span></div>`).join('');
  const head=days.map(day=>`<div class="calhead${day.key===today?' today':''}">${day.date.getDate()} 日 周${WEEKDAYS[(day.date.getDay()+6)%7]}</div>`).join('');
  const allDay=days.map(day=>`<div class="calallday">${day.allDay.map(item=>chip(item,{showTime:false})).join('')}</div>`).join('');
  const columns=days.map(day=>`<div class="calcol${day.key===today?' today':''}" data-calday="${day.key}">${day.timed.map(item=>`<button class="calblock" data-calevent="${esc(item.id)}" style="top:${item.top}%;height:${item.height}%" title="${esc(item.data.title)}"><i>${esc(item.time)}</i><span>${esc(item.data.title)}</span></button>`).join('')}</div>`).join('');
  return `<div class="calweek"><div class="calweekhead"><span class="calhourhead"></span>${head}</div><div class="calalldayrow"><span class="calhourhead">全天</span>${allDay}</div><div class="calweekbody"><div class="calhours">${hours}</div>${columns}</div></div>`;
 }
 function render(){
  if(!host)return;
  const {cursor}=state;
  const title=state.view==='month'?monthTitle(cursor.getFullYear(),cursor.getMonth()):weekTitle(startOfWeek(cursor));
  host.innerHTML=`
   <div class="calbar">
    <div class="seg" role="tablist">
     <button class="${state.view==='month'?'active':''}" data-calview="month" role="tab">月</button>
     <button class="${state.view==='week'?'active':''}" data-calview="week" role="tab">周</button>
    </div>
    <div class="calnav">
     <button class="btn" data-calstep="-1" type="button" aria-label="上一页">‹</button>
     <button class="btn" data-calstep="today" type="button">今天</button>
     <button class="btn" data-calstep="1" type="button" aria-label="下一页">›</button>
    </div>
    <strong class="caltitle" data-caltitle="1">${esc(title)}</strong>
   </div>
   ${state.view==='month'?renderMonth():renderWeek()}`;
  for(const button of host.querySelectorAll('[data-calview]'))button.onclick=()=>{state.view=button.dataset.calview;render()};
  for(const button of host.querySelectorAll('[data-calstep]'))button.onclick=()=>{
   const step=button.dataset.calstep;
   if(step==='today')state.cursor=new Date();
   else if(state.view==='month')state.cursor=new Date(state.cursor.getFullYear(),state.cursor.getMonth()+Number(step),1);
   else state.cursor=new Date(state.cursor.getFullYear(),state.cursor.getMonth(),state.cursor.getDate()+Number(step)*7);
   render();
  };
  for(const button of host.querySelectorAll('[data-calevent]'))button.onclick=event=>{event.stopPropagation();open?.(button.dataset.calevent)};
  // 周视图默认停在 00:00 会看不到白天的日程（苹果日历会自动滚到"现在/首个日程"）。
  if(state.view==='week'){
   const scroller=host.querySelector('.calweek');
   const blocks=[...host.querySelectorAll('.calblock')];
   const target=blocks.length?Math.min(...blocks.map(block=>block.offsetTop)):8*34;
   if(scroller)scroller.scrollTop=Math.max(0,target-34*2);
  }
 }
 return {render,setItems(next){items=next;render()},dispose(){if(host)host.replaceChildren()}};
}
