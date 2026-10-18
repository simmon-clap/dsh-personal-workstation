import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {DomainError} from './store.mjs';

/** 苹果日历桥接：macOS 上不需要任何凭证，只要进程有「自动化 → 日历」权限。
 *  实测（2026-10-12）：从 DSH 子进程直接执行即可读到 12 个日历与字段级事件。
 *
 *  设计要点：
 *   · 读 = `readEvents`；写 = `writeEvent` / `deleteEvent`（同一个权限）；
 *   · 所有 AppleScript 都由本模块生成，调用方只给结构化参数，不拼脚本；
 *   · 副作用只发生在**目标日历**（默认「个人工作台」这个专属日历），
 *     其它日历只作读取来源——避免动到用户自己的日历；
 *   · 失败一律抛出可操作的原因（权限未开 / 未登录 iCloud / 找不到日历）。 */

export const APPLE_SOURCE='apple-calendar';
/** 默认排除的噪音日历：这些日历里没有"我的日程"，全量同步只会把界面灌满。 */
export const NOISE_CALENDARS=['中国大陆节假日','中国大陆节假日（调休）','生日','Siri建议','计划的提醒事项','订阅日历','Holidays'];
export const DEFAULT_TARGET='个人工作台';
const FIELD_SEP='\u001f';
const RECORD_SEP='\u001e';
const DEFAULT_PERMISSION_HINT='请在「系统设置 → 隐私与安全性 → 自动化」里允许 DSH 控制「日历」，然后重试。';

export const appleCalendarScripts={
 list:`tell application "Calendar"
  set output to ""
  repeat with c in calendars
    set output to output & (name of c) & "\\n"
  end repeat
  return output
end tell`,
};

const coreHandlers=`
on pad2(n)
  if n < 10 then return "0" & n
  return "" & n
end pad2
on isoDate(s)
  set y to (text 1 thru 4 of s) as integer
  set mo to (text 6 thru 7 of s) as integer
  set d to (text 9 thru 10 of s) as integer
  set hh to (text 12 thru 13 of s) as integer
  set mi to (text 15 thru 16 of s) as integer
  set ss to (text 18 thru 19 of s) as integer
  set theDate to current date
  set day of theDate to 1
  set year of theDate to y
  set month of theDate to mo
  set day of theDate to d
  set hours of theDate to hh
  set minutes of theDate to mi
  set seconds of theDate to ss
  return theDate
end isoDate
on isoText(d)
  return (year of d as integer) & "-" & my pad2(month of d as integer) & "-" & my pad2(day of d) & "T" & my pad2(hours of d) & ":" & my pad2(minutes of d) & ":" & my pad2(seconds of d)
end isoText
on textOrEmpty(v)
  try
    if v is missing value then return ""
    return v as text
  on error
    return ""
  end try
end textOrEmpty
on inList(item, theList)
  repeat with x in theList
    if (x as text) = item then return true
  end repeat
  return false
end inList
`;

function quoted(value){
 return '"'+String(value??'').replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
}
function literalList(values){
 return '{'+values.map(quoted).join(', ')+'}';
}
export function normalizeAppleError(error){
 const text=[error?.stderr,error?.message].filter(Boolean).join(' ');
 if(/-1743|Not authorized|not allowed assistive|不允许/.test(text))return {code:'FORBIDDEN',message:'没有「日历」的自动化权限。'+DEFAULT_PERMISSION_HINT};
 if(/-600|Application isn.t running/.test(text))return {code:'UNAVAILABLE',message:'日历应用没有响应，请先打开「日历」再重试。'};
 if(/Can.t get calendar|找不到|not found/i.test(text))return {code:'NOT_FOUND',message:'找不到指定的日历（可能已改名或未同步到本机）。'};
 if(/-1728|-2741|-1700/.test(text))return {code:'INVALID',message:'日历拒绝了这次操作：'+text.trim().slice(0,300)};
 return {code:'UNAVAILABLE',message:'日历操作失败：'+(text.trim().slice(0,300)||'未知原因')};
}

function defaultRun(script,{timeoutMs=20000}={}){
 return new Promise((resolve,reject)=>{
  execFile('/usr/bin/osascript',['-e',script],{timeout:timeoutMs,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{
   // 注意：展开 Error 会丢掉 message（不可枚举）→ 显式取 message/stderr，否则真实原因会被吞成"未知原因"。
   if(error){const normalized=normalizeAppleError({message:error.message,stderr:[String(stderr??''),String(stdout??'')].join(' ')});reject(Object.assign(new Error(normalized.message),{code:normalized.code}));return}
   resolve(String(stdout??''));
  });
 });
}

export function createAppleCalendar({run=defaultRun,timeoutMs=20000}={}){
 const exec=script=>run(script,{timeoutMs});
 return {
  async listCalendars(){
   const output=await exec(appleCalendarScripts.list);
   return output.split('\n').map(line=>line.trim()).filter(Boolean);
  },
  /** 读指定日历在时间窗内的事件。calendars 为空则读全部（调用方应已过滤噪音）。
   *  ⚠️ 第三个实测坑：**tell 块里不要调用 handler**——`my isoText(start date of e)` 与日期比较
   *  会在 Calendar 的术语环境里出错（实测报"不能将列表转换为 integer"、或静默读不到任何事件）。
   *  所以读取路径改成"纯算术时间戳"：边界在 Node 侧算好，AppleScript 只做加减乘除比较。 */
  async readEvents({calendars=[],from,to}={}){
   if(!from||!to)throw new DomainError('INVALID','读取日历需要时间窗（from / to）');
   // ⚠️ 四个实测坑（都会静默出错）：tell 块里不能调 handler、变量名不能与日历术语重名、
   //   AppleScript 整数是 32 位（14 位时间戳会变浮点）→ 用「日期键 YYYYMMDD + 当日秒数」两个小整数比较，
   //   边界由 Node 侧同算法算出。日历过滤用纯比较链（`my inList(...)` 在 tell 块里会失败）。
   const bounds=dateKeys(from,to);
   const filter=calendars.length?`    if (${calendars.map(name=>'cname = '+quoted(name)).join(' or ')}) then`:'    if (true) then';
   const keys=(prefix,source)=>`set ws${prefix}T to ${source}
          set ws${prefix}Date to (year of ws${prefix}T) * 10000 + (month of ws${prefix}T as integer) * 100 + (day of ws${prefix}T)
          set ws${prefix}Time to (hours of ws${prefix}T) * 3600 + (minutes of ws${prefix}T) * 60 + (seconds of ws${prefix}T)`;
   const script=`set FS to (ASCII character 31)
set RS to (ASCII character 30)
set wsFromDate to ${bounds.fromDate}
set wsFromTime to ${bounds.fromTime}
set wsToDate to ${bounds.toDate}
set wsToTime to ${bounds.toTime}
set output to ""
tell application "Calendar"
  repeat with c in calendars
    set cname to name of c
${filter}
      repeat with e in events of c
        ${keys('Start','start date of e')}
        if (wsStartDate > wsFromDate or (wsStartDate = wsFromDate and wsStartTime ≥ wsFromTime)) and (wsStartDate < wsToDate or (wsStartDate = wsToDate and wsStartTime ≤ wsToTime)) then
          ${keys('End','end date of e')}
          set wsTitle to ""
          set wsLoc to ""
          set wsNote to ""
          set wsAllDay to "false"
          try
            set wsRaw to summary of e
            if wsRaw is not missing value then set wsTitle to wsRaw as text
          end try
          try
            set wsRaw to location of e
            if wsRaw is not missing value then set wsLoc to wsRaw as text
          end try
          try
            set wsRaw to description of e
            if wsRaw is not missing value then set wsNote to wsRaw as text
          end try
          try
            if (allday event of e) then set wsAllDay to "true"
          end try
          set output to output & (uid of e) & FS & cname & FS & wsTitle & FS & wsStartDate & FS & wsStartTime & FS & wsEndDate & FS & wsEndTime & FS & wsAllDay & FS & wsLoc & FS & wsNote & RS
        end if
      end repeat
    end if
  end repeat
end tell
return output`;
   const output=await exec(script);
   return parseEventsOutput(output);
  },
  async hasCalendar(name){
   const calendars=await this.listCalendars();
   return calendars.includes(name);
  },
  /** 目标日历不存在时创建一个（用户自己的日历不受影响）。 */
  async ensureCalendar(name){
   const calendars=await this.listCalendars();
   if(calendars.includes(name))return {created:false};
   const script=`tell application "Calendar"
  set newCal to make new calendar with properties {name:${quoted(name)}}
  return name of newCal
end tell`;
   try{
    await exec(script);
    return {created:true};
   }catch(error){
    throw Object.assign(new Error('无法创建日历「'+name+'」：'+error.message+' 你也可以在「日历」里手动新建一个同名日历后重试。'),{code:error.code??'UNAVAILABLE'});
   }
  },
  /** 新建或按 uid 更新一条事件（只写目标日历）。
   *  ⚠️ 两个实测坑（都会**静默**出错，不报错）：
   *  ① record 字面量里不能调用 handler：`with properties {start date:my isoDate("…")}` 不会报错，
   *     但日期会被丢掉、事件落到"当前时间" → 必须先算进变量；
   *  ② 变量名不能与日历术语重名：在 `tell application "Calendar"` 块里写 `startDate` / `endDate`，
   *     AppleScript 会把它们当成日历的 `start date` / `end date` 属性，同样静默丢掉日期
   *     （读取时也会让比较永远不成立 → 明明有事件却读不到）→ 一律用 ws 前缀。 */
  async writeEvent({calendar,uid,title,start,end,allDay=false,location='',notes=''}){
   const startText=allDay?start+'T00:00:00':normalizeLocalDateTime(start);
   const endText=allDay?(end||start)+'T23:59:59':normalizeLocalDateTime(end||start);
   const properties=[
    'summary:'+quoted(title),
    'start date:startDate',
    'end date:endDate',
    'allday event:'+(allDay?'true':'false'),
    ...(location?['location:'+quoted(location)]:[]),
    ...(notes?['description:'+quoted(notes)]:[]),
   ].join(', ');
   const script=`${coreHandlers}
set wsStartAt to my isoDate(${quoted(startText)})
set wsEndAt to my isoDate(${quoted(endText)})
tell application "Calendar"
  set targetCal to missing value
  repeat with c in calendars
    if (name of c) = ${quoted(calendar)} then set targetCal to c
  end repeat
  if targetCal is missing value then error "找不到日历：${calendar}"
  ${uid?`set hits to (every event of targetCal whose uid = ${quoted(uid)})
  if (count of hits) > 0 then
    set targetEvent to item 1 of hits
    set summary of targetEvent to ${quoted(title)}
    ${location?`set location of targetEvent to ${quoted(location)}`:''}
    ${notes?`set description of targetEvent to ${quoted(notes)}`:''}
    tell targetEvent to set {allday event, start date, end date} to {${allDay?'true':'false'}, wsStartAt, wsEndAt}
    return (uid of targetEvent)
  end if`:''}
  set newEvent to make new event at end of events of targetCal with properties {summary:${quoted(title)}, start date:wsStartAt, end date:wsEndAt, allday event:${allDay?'true':'false'}${location?', location:'+quoted(location):''}${notes?', description:'+quoted(notes):''}}
  return (uid of newEvent)
end tell`;
   const output=await exec(script);
   return String(output).trim();
  },
  async deleteEvent({calendar,uid}){
   const script=`tell application "Calendar"
  set targetCal to missing value
  repeat with c in calendars
    if (name of c) = ${quoted(calendar)} then set targetCal to c
  end repeat
  if targetCal is missing value then error "找不到日历：${calendar}"
  set hits to (every event of targetCal whose uid = ${quoted(uid)})
  if (count of hits) = 0 then return "missing"
  repeat with e in hits
    delete e
  end repeat
  return "deleted"
end tell`;
   return String(await exec(script)).trim()==='deleted';
  },
 };
}

/** 解析 readEvents 的输出：日期以「YYYYMMDD + 当日秒数」两个整数返回，在这里还原成本地时间串。 */
export function parseEventsOutput(output){
 // ⚠️ 必须先按分隔符 split、再清理每个字段里的控制字符：先 clean 会把分隔符替换掉，导致永远解析不到字段。
 const tidy=value=>{const text=String(value??'').replace(/[\u001e\u001f\n\r]/g,' ').trim();return text==='missing value'?'':text};
 return String(output??'').split(RECORD_SEP).map(record=>record.replace(/^\n+|\n+$/g,'')).filter(record=>record.includes(FIELD_SEP)).map(record=>{
  const [uid,calendar,title,startDate,startTime,endDate,endTime,allDay,location,notes]=record.split(FIELD_SEP).map(tidy);
  const fields={title:title||'（无标题）',start:isoFromKeys(startDate,startTime),end:isoFromKeys(endDate,endTime),allDay:String(allDay).trim()==='true',location:location||'',notes:notes||''};
  // Calendar 的 AppleScript 字典**没有** modification date（实测 -1728），所以变更检测用内容指纹。
  return {uid,calendar,...fields,fingerprint:eventFingerprint(fields)};
 }).filter(event=>event.uid);
}
/** 本地时间串 → 「YYYYMMDD + 当日秒数」（与 AppleScript 侧同一算法，保证比较一致）。 */
export function dateKeys(from,to){
 if(!from||!to)throw new DomainError('INVALID','时间窗无效');
 const key=value=>{
  const text=normalizeLocalDateTime(value);
  const [hh,mm,ss]=text.slice(11,19).split(':').map(Number);
  return {date:Number(text.slice(0,10).replace(/-/g,'')),time:hh*3600+mm*60+ss};
 };
 return {fromDate:key(from).date,fromTime:key(from).time,toDate:key(to).date,toTime:key(to).time};
}
export function isoFromKeys(dateKey,timeKey){
 const date=String(dateKey??'').trim(),time=Number(String(timeKey??'').trim());
 if(!/^\d{8}$/.test(date)||!Number.isFinite(time))return '';
 const pad=n=>String(n).padStart(2,'0');
 return `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${pad(Math.floor(time/3600))}:${pad(Math.floor(time%3600/60))}:${pad(time%60)}`;
}
export function parseCalendarsOutput(output){
 return String(output??'').split('\n').map(line=>line.trim()).filter(Boolean);
}
/** 苹果日历返回的是本机时间（没有时区）；工作台里存的是同一种"无时区本地时间"字符串。 */
export function isoFromApple(value){
 const text=String(value??'').trim();
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(text);
 return match?`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`:'';
}
/** 工作台字段 → 苹果日历字段。allDay 用 DATE，其余用本地时间。 */
export function appleFieldsFromRecord(record){
 const data=record.data??{};
 const start=String(data.startDate??'');
 const allDay=!/T\d{2}:\d{2}/.test(start);
 return {
  title:data.title??'未命名',
  start:allDay?start:normalizeLocalDateTime(start),
  end:data.endDate?(allDay?String(data.endDate):normalizeLocalDateTime(String(data.endDate))):'',
  allDay,
  location:data.location??'',
  notes:data.description??'',
 };
}
/** 外部日历时间 → 工作台接受的格式：全天用 YYYY-MM-DD，其余用 YYYY-MM-DDTHH:MM
 *  （校验只接受"无秒无时区"的本地时间，带秒的会被拒绝）。 */
export function toRecordDateTime(value,allDay=false){
 const text=normalizeLocalDateTime(value);
 return allDay?text.slice(0,10):text.slice(0,16);
}
export function normalizeLocalDateTime(value){
 const text=String(value??'').trim();
 if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text+'T00:00:00';
 // 带时区的值（YYYY-MM-DDTHH:MM:SS±HH:MM / Z）：按本机时区换算成本地时间，再交给日历。
 if(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)){
  const date=new Date(text);
  if(!Number.isFinite(date.getTime()))throw new DomainError('INVALID','日程时间无效：'+text);
  const pad=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
 }
 if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text))return text+':00';
 if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text))return text;
 const date=new Date(text);
 if(!Number.isFinite(date.getTime()))throw new DomainError('INVALID','日程时间无效：'+text);
 const pad=n=>String(n).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
const comparable=value=>{
 const text=String(value??'').trim();
 if(!text)return '';
 if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text+'T00:00:00';
 return normalizeLocalDateTime(text);
};
const sameMoment=(a,b)=>comparable(a)===comparable(b);
/** 内容指纹：Calendar 不提供修改时间，所以用「内容是否变了」判断外部改动。 */
export function eventFingerprint(fields){
 // 两侧必须用**同一套规范化**：全天事件只比日期（苹果侧回读会是 00:00:00 / 23:59:59），
 // 定时事件比到分钟（苹果侧回读带秒）——否则会把"没变"误判成"外部改过"，每轮都白拉一次。
 const allDay=Boolean(fields.allDay);
 const start=toRecordDateTime(fields.start,allDay)||'';
 let end=fields.end?toRecordDateTime(fields.end,allDay):'';
 if(allDay&&end&&end===start)end='';
 const canonical=[fields.title??'',start,end,allDay?'1':'0',fields.location??''].join('\u001f');
 return createHash('sha1').update(canonical).digest('hex').slice(0,16);
}
function recordFields(record){
 const fields=appleFieldsFromRecord(record);
 return {title:fields.title,start:fields.start,end:fields.end,allDay:fields.allDay,location:fields.location,notes:fields.notes};
}
function appleComparable(event){
 return {title:event.title??'',start:comparable(event.start),end:comparable(event.end),allDay:Boolean(event.allDay),location:event.location??'',notes:event.notes??''};
}
function fieldsEqual(a,b){
 return a.title===b.title&&sameMoment(a.start,b.start)&&sameMoment(a.end||a.start,b.end||b.start)&&a.allDay===b.allDay&&(a.location??'')===(b.location??'');
}

/** 同步计划：纯函数，输入两侧现状，输出要做的动作。
 *  规则（v1，写进发布说明）：
 *   · 目标日历 = 工作台非归档事务的**镜像**（工作台是这一份日历的源头）；
 *   · 用户在目标日历里新建的事件 → 拉回工作台（新建记录）；
 *   · 两侧都改过 → 冲突：目标日历按「工作台优先」，并在 conflicts 里留痕（不做静默覆盖）；
 *   · 苹果侧被删除 → **不自动删工作台记录**（列进 removedInApple 交给你决定）；
 *   · 未同步过的记录（没有 externalUid）→ 新建到目标日历。
 *  变更检测用内容指纹（Calendar 不提供修改时间）。 */
export function planSync({records=[],appleEvents=[],now}={}){
 const stamp=now??new Date().toISOString();
 const byUid=new Map(appleEvents.map(event=>[event.uid,event]));
 const push=[],pull=[],conflicts=[],removedInApple=[],skipped=[];
 const claimed=new Set();
 for(const record of records){
  if(record.archived)continue;
  const data=record.data??{};
  const uid=data.externalUid;
  const syncedAt=data.externalSyncedAt??'';
  const workbenchChanged=(record.updatedAt??'')>syncedAt;
  if(!uid){push.push({op:'create',recordId:record.id,fields:recordFields(record)});continue}
  const event=byUid.get(uid);
  claimed.add(uid);
  if(!event){removedInApple.push({recordId:record.id,uid});continue}
  const fresh=appleComparable(event);
  const appleChanged=eventFingerprint({title:fresh.title,start:fresh.start,end:fresh.end,allDay:fresh.allDay,location:fresh.location})!==(data.externalFingerprint??'');
  const differs=!fieldsEqual(recordFields(record),fresh);
  if(workbenchChanged&&appleChanged){
   // 目标日历以工作台为准；不做静默覆盖，冲突留痕给用户看。
   conflicts.push({recordId:record.id,uid,winner:'workbench',title:data.title??''});
   if(differs)push.push({op:'update',recordId:record.id,uid,fields:recordFields(record)});
   else skipped.push({recordId:record.id,reason:'冲突但内容一致'});
   continue;
  }
  if(workbenchChanged){if(differs)push.push({op:'update',recordId:record.id,uid,fields:recordFields(record)});else skipped.push({recordId:record.id,reason:'两侧一致'});continue}
  if(appleChanged){pull.push({op:'update',recordId:record.id,uid,fields:fresh});continue}
  skipped.push({recordId:record.id,reason:'无变化'});
 }
 for(const event of appleEvents){
  if(claimed.has(event.uid))continue;
  pull.push({op:'create',uid:event.uid,fields:appleComparable(event)});
 }
 return {
  push,pull,conflicts,removedInApple,skipped,
  summary:{
   pushCreate:push.filter(item=>item.op==='create').length,
   pushUpdate:push.filter(item=>item.op==='update').length,
   pullCreate:pull.filter(item=>item.op==='create').length,
   pullUpdate:pull.filter(item=>item.op==='update').length,
   conflicts:conflicts.length,removedInApple:removedInApple.length,skipped:skipped.length,at:stamp,
  },
 };
}

/** 从其它日历导入为草稿：只挑没导入过的事件（按 uid 去重），不做任何写入。 */
export function planImport({appleEvents=[],records=[],calendars=[]}={}){
 const known=new Set(records.map(record=>record.data?.externalUid).filter(Boolean));
 const wanted=calendars.length?new Set(calendars):null;
 return appleEvents
  .filter(event=>(!wanted||wanted.has(event.calendar))&&!known.has(event.uid))
  .map(event=>({
   op:'create',kind:'event',
   data:{
    title:event.title||'（无标题）',
    startDate:toRecordDateTime(event.start,event.allDay),
    ...(event.end?{endDate:toRecordDateTime(event.end,event.allDay)}:{}),
    ...(event.location?{location:event.location}:{}),
    ...(event.notes?{description:event.notes}:{}),
    externalSource:APPLE_SOURCE,externalUid:event.uid,externalSyncedAt:new Date().toISOString(),externalFingerprint:eventFingerprint(event),
   },
  }));
}
/** 工作台记录 → 拉取更新要写回的字段（保留工作台自己的 title 之外的字段不动）。 */
export function pullFields(event){
 return {
  title:event.title||'（无标题）',
  startDate:toRecordDateTime(event.start,event.allDay),
  ...(event.end?{endDate:toRecordDateTime(event.end,event.allDay)}:{}),
  location:event.location??'',
  ...(event.notes?{description:event.notes}:{}),
  externalSource:APPLE_SOURCE,externalUid:event.uid,externalSyncedAt:new Date().toISOString(),externalFingerprint:eventFingerprint(event),
 };
}
/** 判断一个日历名是否属于噪音（默认要排除的那一类）。 */
export function isNoiseCalendar(name,{noise=NOISE_CALENDARS,include=[]}={}){
 if(include.includes(name))return false;
 return noise.some(entry=>name===entry||name.includes(entry));
}
