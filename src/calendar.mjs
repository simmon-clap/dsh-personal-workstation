import {createHash} from 'node:crypto';
export function calendarUid(workspace,id){return createHash('sha256').update(JSON.stringify([workspace,id])).digest('hex')+'@personal-workstation';}
import {DomainError} from './store.mjs';
const escapeText=s=>String(s??'').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function fold(line){let output='',part='';for(const char of line){if(Buffer.byteLength(part+char,'utf8')>75){output+=part+'\r\n';part=' ';}part+=char;}return output+part;}
function instant(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new DomainError('INVALID','日程时间无效');return date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
function nextDay(value){const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10).replace(/-/g,'');}
/** DATE endDate is inclusive in this export; RFC5545 DTEND is exclusive. */
export function exportCalendar(store,ctx,{ids,now=new Date()}={}){
 store.context(ctx);if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new DomainError('INVALID','请选择1至100个不重复的日程');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Personal Workstation//Calendar Export//ZH','CALSCALE:GREGORIAN'];
 for(const id of ids){const item=store.get(ctx,id);if(!item||item.archived||item.kind!=='event')throw new DomainError('NOT_FOUND','日程不存在或已归档');const d=item.data;if(!d.startDate)throw new DomainError('INVALID','日程缺少开始时间');const allDay=/^\d{4}-\d{2}-\d{2}$/.test(d.startDate);if(d.endDate&&allDay!==/^\d{4}-\d{2}-\d{2}$/.test(d.endDate))throw new DomainError('INVALID','开始与结束必须同为日期或具体时间');
 if(d.endDate&&(Date.parse(d.endDate)<Date.parse(d.startDate)||(!allDay&&Date.parse(d.endDate)===Date.parse(d.startDate))))throw new DomainError('INVALID','日程结束必须晚于开始；全天日程可在同一天结束');
 lines.push('BEGIN:VEVENT','UID:'+calendarUid(ctx.workspace,id),'DTSTAMP:'+instant(now),'SUMMARY:'+escapeText(d.title));
 if(allDay){lines.push('DTSTART;VALUE=DATE:'+d.startDate.replace(/-/g,''),'DTEND;VALUE=DATE:'+nextDay(d.endDate||d.startDate));}else{lines.push('DTSTART:'+instant(d.startDate));if(d.endDate)lines.push('DTEND:'+instant(d.endDate));}
 if(d.description)lines.push('DESCRIPTION:'+escapeText(d.description));if(d.location)lines.push('LOCATION:'+escapeText(d.location));lines.push('END:VEVENT');
 }
 lines.push('END:VCALENDAR');return {filename:'workstation-calendar.ics',mime:'text/calendar; charset=utf-8',content:lines.map(fold).join('\r\n')+'\r\n'};
}
