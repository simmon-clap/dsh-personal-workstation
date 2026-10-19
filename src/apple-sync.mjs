import {DomainError} from './store.mjs';
import {toZonedDateTime} from './validation.mjs';
import {APPLE_SOURCE,DEFAULT_TARGET,NOISE_CALENDARS,isNoiseCalendar,planSync,planImport,pullFields,eventFingerprint,toRecordDateTime} from './apple-calendar.mjs';

/** 苹果日历同步服务：把「桥接（AppleScript）」和「工作台存储（草稿→提交→回执）」接起来。
 *
 *  规矩：
 *   · 只有**目标日历**会被写入（默认「个人工作台」这个专属日历），用户自己的日历只读；
 *   · 工作台的每次写入都走 draft → commit（幂等键 + 回执），所以同步结果可以按回执撤销；
 *   · 从**其它日历**导入走"还没确认的改动"，交用户在收件箱确认——不静默把用户日历灌进业务数据；
 *   · 苹果侧被删除的事件**不自动删工作台记录**，列出来交用户决定。 */

/** store.list 直接返回数组（浏览器层才包成 {items}）——这里兼容两种形态。 */
function listAll(store,ctx,args){
 const result=store.list(ctx,args);
 return Array.isArray(result)?result:(result?.items??[]);
}

export const APPLE_DEFAULTS={targetCalendar:DEFAULT_TARGET,pastDays:30,futureDays:30,includeCalendars:[],excludeCalendars:NOISE_CALENDARS};

/** 定时事务没有结束时间时的兜底：+1 小时（本地时间串，不涉及时区换算）。 */
export function addHour(value){
 const text=String(value??'');
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(text);
 if(!match)return text;
 const next=new Date(`${match[1]}T${match[2]}:${match[3]}:00`);
 if(!Number.isFinite(next.getTime()))return text;
 next.setHours(next.getHours()+1);
 const pad=n=>String(n).padStart(2,'0');
 return `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}:00`;
}
export function appleWindow({pastDays=APPLE_DEFAULTS.pastDays,futureDays=APPLE_DEFAULTS.futureDays,now=new Date()}={}){
 const pad=value=>String(value).padStart(2,'0');
 const local=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
 const past=new Date(now.getTime()-pastDays*86400000);
 const future=new Date(now.getTime()+futureDays*86400000);
 past.setHours(0,0,0,0);
 future.setHours(23,59,59,0);
 return {from:local(past),to:local(future)};
}

/** 同步设置：配置里的日历白名单优先；没有配置就"排除噪音后的全部"。 */
export function syncCalendars({calendars=[],config={}}={}){
 // 用户在配置里加的排除项是**追加**到默认噪音表，而不是替换它（否则"排除一个"会把节假日全放回来）。
 const excluded=new Set([...NOISE_CALENDARS,...(config.excludeCalendars??[])]);
 const included=config.includeCalendars??[];
 return calendars.filter(name=>included.length?included.includes(name):!excluded.has(name)&&!isNoiseCalendar(name,{noise:[...excluded],include:[]}));
}

export async function appleStatus({apple,config={}}={}){
 if(!apple)return {available:false,reason:'未加载苹果日历桥接'};
 const window=appleWindow(config);
 try{
  const calendars=await apple.listCalendars();
  const target=config.targetCalendar??APPLE_DEFAULTS.targetCalendar;
  return {
   available:true,window,
   target:{name:target,exists:calendars.includes(target)},
   calendars:calendars.map(name=>({name,noise:isNoiseCalendar(name,{noise:config.excludeCalendars??NOISE_CALENDARS}),selected:syncCalendars({calendars:[name],config}).length>0})),
   syncCalendars:syncCalendars({calendars,config}),
  };
 }catch(error){
  return {available:false,reason:error.message,code:error.code??'UNAVAILABLE',window};
 }
}

function openedChanges(plan,store,ctx){return (plan.push??[]).map(item=>({op:'update',id:item.recordId,data:{externalSource:APPLE_SOURCE,externalUid:item.uid??'',externalSyncedAt:new Date().toISOString(),externalFingerprint:''}}))}

/** 执行同步。mode：both | push | pull。返回可直接展示的摘要。 */
export async function runAppleSync({store,ctx,apple,config={},mode='both',now=new Date()}={}){
 if(!apple)throw new DomainError('UNAVAILABLE','未加载苹果日历桥接（苹果日历同步仅在本机 macOS 上可用）');
 const target=config.targetCalendar??APPLE_DEFAULTS.targetCalendar;
 const window=appleWindow({...config,now});
 const status=await appleStatus({apple,config});
 if(!status.available)throw new DomainError(status.code??'UNAVAILABLE',status.reason);
 let createdCalendar=false;
 if(mode!=='pull'){
  const ensured=await apple.ensureCalendar(target);
  createdCalendar=ensured.created;
 }
 const appleEvents=await apple.readEvents({calendars:[target],from:window.from,to:window.to});
 const records=listAll(store,ctx,{kind:'event',limit:200,includeArchived:false});
 const plan=planSync({records,appleEvents,now:now.toISOString()});
 const result={mode,window,target,createdCalendar,plan:plan.summary,actions:{push:[],pull:[],removedInApple:plan.removedInApple,conflicts:plan.conflicts},errors:[]};

 // ① 推送：写苹果日历 → 成功后把外部字段写回记录（同一个批次里提交，可撤销）
 const pushedUids=new Set();
 if(mode!=='pull'){
  for(const item of plan.push){
   const record=records.find(entry=>entry.id===item.recordId);if(!record)continue;
   try{
    // 没有结束时间的定时事务：默认给 1 小时，避免在日历里变成零长度事件。
    const fields={...item.fields};
    if(!fields.allDay&&!fields.end)fields.end=addHour(fields.start);
    const uid=item.op==='create'
     ? await apple.writeEvent({calendar:target,...fields})
     : await apple.writeEvent({calendar:target,uid:item.uid,...fields});
    const fingerprint=eventFingerprint({title:item.fields.title,start:item.fields.start,end:item.fields.end,allDay:item.fields.allDay,location:item.fields.location});
    const {item:fresh}=await Promise.resolve({item:store.get(ctx,record.id)});
    const data={...fresh.data,externalSource:APPLE_SOURCE,externalUid:uid,externalSyncedAt:now.toISOString(),externalFingerprint:fingerprint};
    const batch=store.draft(ctx,{title:`苹果日历同步 · 推送 ${item.op==='create'?'新建':'更新'}`,changes:[{op:'update',id:record.id,expectedRevision:fresh.revision,data,sources:{externalUid:'苹果日历同步写入',externalSource:'苹果日历同步写入',externalSyncedAt:'苹果日历同步写入',externalFingerprint:'苹果日历同步写入'}}]});
    store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:`apple-push:${record.id}:${fingerprint}:${now.toISOString()}`});
    pushedUids.add(uid);
    result.actions.push.push({recordId:record.id,op:item.op,uid,title:item.fields.title});
   }catch(error){result.errors.push({stage:'push',recordId:item.recordId,reason:error.message})}
  }
 }
 // ② 拉取：把目标日历里的新建/改动写回工作台（同样走批次）
 if(mode!=='push'){
  for(const item of plan.pull){
   try{
    // 本次刚推上去的事件不要又拉回来（否则会重复建记录）。
    if(item.op==='create'&&pushedUids.has(item.uid)){result.actions.pull.push({op:'skip',uid:item.uid,title:item.fields.title,reason:'本次刚推送'});continue}
    if(item.op==='create'){
     const data={title:item.fields.title,startDate:toZonedDateTime(toRecordDateTime(item.fields.start,item.fields.allDay)),
      ...(item.fields.end?{endDate:toZonedDateTime(toRecordDateTime(item.fields.end,item.fields.allDay))}:{}),
      ...(item.fields.location?{location:item.fields.location}:{}),
      ...(item.fields.notes?{description:item.fields.notes}:{}),
      externalSource:APPLE_SOURCE,externalUid:item.uid,externalSyncedAt:now.toISOString(),
      externalFingerprint:eventFingerprint({title:item.fields.title,start:item.fields.start,end:item.fields.end,allDay:item.fields.allDay,location:item.fields.location})};
     const batch=store.draft(ctx,{title:'苹果日历同步 · 拉取新建',changes:[{op:'create',kind:'event',data,sources:{title:'苹果日历同步拉取'}}]});
     store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:`apple-pull-create:${item.uid}:${now.toISOString()}`});
     pushedUids.add(item.uid);
     result.actions.pull.push({op:'create',uid:item.uid,title:item.fields.title});
    }else{
     // 推送阶段可能刚改过这条记录：重新取一次，避免用过期 revision 提交。
     const record=store.get(ctx,item.recordId);if(!record)continue;
     const pulled=pullFields({...item.fields,allDay:item.fields.allDay});
     const data={...record.data,...pulled,startDate:toZonedDateTime(pulled.startDate),...(pulled.endDate?{endDate:toZonedDateTime(pulled.endDate)}:{})};
     const batch=store.draft(ctx,{title:'苹果日历同步 · 拉取更新',changes:[{op:'update',id:record.id,expectedRevision:record.revision,data,sources:{title:'苹果日历同步拉取',startDate:'苹果日历同步拉取',endDate:'苹果日历同步拉取',location:'苹果日历同步拉取',externalSyncedAt:'苹果日历同步拉取',externalFingerprint:'苹果日历同步拉取'}}]});
     store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:`apple-pull-update:${record.id}:${now.toISOString()}`});
     result.actions.pull.push({op:'update',recordId:record.id,uid:item.uid,title:item.fields.title});
    }
   }catch(error){result.errors.push({stage:'pull',uid:item.uid,reason:error.message})}
  }
 }
 return result;
}

/** 从其它日历导入为**草稿**（不提交，交用户在收件箱确认）。 */
export async function appleImportDraft({store,ctx,apple,config={},now=new Date()}={}){
 if(!apple)throw new DomainError('UNAVAILABLE','未加载苹果日历桥接');
 const status=await appleStatus({apple,config});
 if(!status.available)throw new DomainError(status.code??'UNAVAILABLE',status.reason);
 const calendars=status.syncCalendars.filter(name=>name!==(config.targetCalendar??APPLE_DEFAULTS.targetCalendar));
 if(!calendars.length)throw new DomainError('INVALID','没有可导入的日历（白名单为空，或只剩目标日历）');
 const window=appleWindow({...config,now});
 const appleEvents=await apple.readEvents({calendars,from:window.from,to:window.to});
 const records=listAll(store,ctx,{kind:'event',limit:200,includeArchived:true});
 const changes=planImport({appleEvents,records,calendars});
 if(!changes.length)return {draft:null,imported:0,calendars,window,scanned:appleEvents.length};
 const batch=store.draft(ctx,{title:`苹果日历导入 · ${changes.length} 条（${calendars.join('、')}）`,changes,source:{appleCalendars:calendars,window}});
 return {draft:batch,imported:changes.length,calendars,window,scanned:appleEvents.length};
}
