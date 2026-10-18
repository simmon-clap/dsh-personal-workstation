import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAppleCalendar,parseEventsOutput,isoFromKeys,dateKeys,eventFingerprint,toRecordDateTime,isNoiseCalendar,planSync,planImport,NOISE_CALENDARS} from '../src/apple-calendar.mjs';
import {appleWindow,syncCalendars,appleStatus,runAppleSync,appleImportDraft} from '../src/apple-sync.mjs';
import {WorkstationStore} from '../src/store.mjs';

/** 假桥接：把 AppleScript 的行为换成一个内存日历，测试不碰真实系统。 */
function fakeApple({calendars=['个人工作台','个人安排','中国大陆节假日'],events=[],writeError=null}={}){
 const store={calendars:[...calendars],events:events.map(event=>({...event}))};
 let seq=0;
 return {
  store,
  async listCalendars(){return [...store.calendars]},
  async ensureCalendar(name){if(store.calendars.includes(name))return {created:false};store.calendars.push(name);return {created:true}},
  async readEvents({calendars=[],from,to}={}){
   return store.events.filter(event=>!calendars.length||calendars.includes(event.calendar)).filter(event=>{
    const key=dateKeys(from,to);
    const start=event.start.replace(/[-:T]/g,'').slice(0,8);
    const mine=Number(start);
    return mine>=key.fromDate&&mine<=key.toDate;
   }).map(event=>({...event,fingerprint:eventFingerprint(event)}));
  },
  async writeEvent({calendar,uid,title,start,end,allDay=false,location=''}){
   if(writeError)throw Object.assign(new Error(writeError),{code:'FORBIDDEN'});
   if(uid){
    const found=store.events.find(event=>event.uid===uid);
    if(found){Object.assign(found,{title,start,end,allDay,location});return uid}
   }
   const next='uid-'+(++seq);
   store.events.push({uid:next,calendar,title,start,end,allDay,location});
   return next;
  },
  async deleteEvent({uid}){const before=store.events.length;store.events=store.events.filter(event=>event.uid!==uid);return store.events.length<before},
 };
}
const seed=async({records=[]}={})=>{
 const store=new WorkstationStore(':memory:');
 const ctx={workspace:'w',actor:'operator',canWrite:true};
 const changes=records.map(record=>({op:'create',id:record.id,kind:'event',data:record.data}));
 if(changes.length){const batch=store.draft(ctx,{title:'种子',changes});store.commit(ctx,{batchId:batch.id,revision:1,key:'seed'})}
 return {store,ctx};
};

test('解析：字段分隔符先 split 再清理（曾经的 bug 是顺序反了就永远读不到）',()=>{
 const FS='\u001f',RS='\u001e';
 const line=['uid-1','个人工作台','与示例科技对齐','20261013','64800','20261013','68400','false','',''].join(FS)+RS;
 const events=parseEventsOutput(line);
 assert.equal(events.length,1);
 assert.equal(events[0].uid,'uid-1');
 assert.equal(events[0].title,'与示例科技对齐');
 assert.equal(events[0].start,'2026-10-13T18:00:00');
 assert.equal(events[0].end,'2026-10-13T19:00:00');
 assert.equal(events[0].allDay,false);
 // 苹果的 missing value 必须归一成空，不能把字符串写进记录
 const withMissing=parseEventsOutput(['uid-2','个人工作台','全天','20261020','0','20261020','86399','true','missing value','missing value'].join(FS)+RS);
 assert.equal(withMissing[0].location,'');
 assert.equal(withMissing[0].notes,'');
 assert.equal(withMissing[0].allDay,true);
 // 日期键与还原
 assert.equal(isoFromKeys('20261013','64800'),'2026-10-13T18:00:00');
 assert.deepEqual(dateKeys('2026-10-11T00:00:00','2026-11-11T23:59:59'),{fromDate:20261011,fromTime:0,toDate:20261111,toTime:86399});
});

test('指纹：全天只比日期、定时比到分钟——两侧规范化一致才不会把"没变"当成"外部改过"',()=>{
 const timed=eventFingerprint({title:'会议',start:'2026-10-13T18:00',end:'2026-10-13T19:00',allDay:false,location:'线上'});
 const timedWithSeconds=eventFingerprint({title:'会议',start:'2026-10-13T18:00:00',end:'2026-10-13T19:00:00',allDay:false,location:'线上'});
 assert.equal(timed,timedWithSeconds);
 const allDay=eventFingerprint({title:'交付',start:'2026-10-20',end:'',allDay:true,location:''});
 const allDayFromApple=eventFingerprint({title:'交付',start:'2026-10-20T00:00:00',end:'2026-10-20T23:59:59',allDay:true,location:''});
 assert.equal(allDay,allDayFromApple,'苹果回读的全天事件必须和记录算出同一个指纹');
 assert.notEqual(eventFingerprint({title:'交付（改）',start:'2026-10-20',end:'',allDay:true,location:''}),allDay);
 assert.equal(toRecordDateTime('2026-10-13T18:00:00'),'2026-10-13T18:00','工作台只接受无秒无时区');
 assert.equal(toRecordDateTime('2026-10-20T00:00:00',true),'2026-10-20');
});

test('噪音日历默认排除；白名单可覆盖',()=>{
 assert(NOISE_CALENDARS.includes('中国大陆节假日'));
 assert(isNoiseCalendar('中国大陆节假日'));
 assert(isNoiseCalendar('Siri建议'));
 assert(!isNoiseCalendar('个人安排'));
 const calendars=['个人工作台','个人安排','飞行计划','中国大陆节假日','Siri建议','生日'];
 assert.deepEqual(syncCalendars({calendars}),['个人工作台','个人安排','飞行计划']);
 assert.deepEqual(syncCalendars({calendars,config:{includeCalendars:['个人安排']}}),['个人安排']);
 assert.deepEqual(syncCalendars({calendars,config:{excludeCalendars:['个人安排']}}),['个人工作台','飞行计划']);
});

test('同步计划：新建推送、外部改动拉回、外部删除不自动删工作台记录',()=>{
 const records=[
  {id:'e1',updatedAt:'2026-10-12T00:00:00Z',data:{title:'会议',startDate:'2026-10-13T18:00',externalUid:'uid-1',externalFingerprint:'',externalSyncedAt:'2026-10-12T00:00:00Z'}},
  {id:'e2',updatedAt:'2026-10-12T00:00:00Z',data:{title:'新事务',startDate:'2026-10-14'}},
  {id:'e3',updatedAt:'2026-10-12T00:00:00Z',data:{title:'已删除的',startDate:'2026-10-15',externalUid:'uid-gone',externalFingerprint:'x',externalSyncedAt:'2026-10-12T00:00:00Z'}},
 ];
 const appleEvents=[
  {uid:'uid-1',calendar:'个人工作台',title:'会议（外部改名）',start:'2026-10-13T18:00:00',end:'2026-10-13T19:00:00',allDay:false,location:'',notes:''},
  {uid:'uid-9',calendar:'个人工作台',title:'苹果里新建的',start:'2026-10-16T09:00:00',end:'2026-10-16T10:00:00',allDay:false,location:'',notes:''},
 ];
 const plan=planSync({records,appleEvents});
 assert.equal(plan.summary.pullUpdate,1,'外部改名要拉回');
 assert.equal(plan.pull.find(item=>item.op==='update').recordId,'e1');
 assert.equal(plan.summary.pushCreate,1,'没有 uid 的记录要推送新建');
 assert.equal(plan.push[0].recordId,'e2');
 assert.equal(plan.summary.pullCreate,1,'苹果里新建的要拉回工作台');
 assert.equal(plan.summary.removedInApple,1,'外部删除只登记，不自动删记录');
 assert.deepEqual(plan.removedInApple,[{recordId:'e3',uid:'uid-gone'}]);
});

test('导入为待确认的改动：只挑没导入过的事件，且不直接提交',async()=>{
 const apple=fakeApple({events:[
  {uid:'uid-a',calendar:'个人安排',title:'飞行计划 A',start:'2026-10-20T08:00:00',end:'2026-10-20T10:00:00',allDay:false,location:'虹桥',notes:''},
  {uid:'uid-b',calendar:'个人安排',title:'飞行计划 B',start:'2026-10-21T08:00:00',end:'2026-10-21T10:00:00',allDay:false,location:'',notes:''},
 ]});
 const {store,ctx}=await seed();
 const first=await appleImportDraft({store,ctx,apple,config:{includeCalendars:['个人安排']}});
 assert.equal(first.imported,2);
 assert.equal(store.list(ctx,{kind:'event'}).length,0,'导入只生成待确认的改动，不入库');
 const plan=planImport({appleEvents:apple.store.events.map(e=>({...e,fingerprint:eventFingerprint(e)})),records:[],calendars:['个人安排']});
 assert.equal(plan.length,2);
 assert.equal(plan[0].data.externalSource,'apple-calendar');
 assert.equal(plan[0].data.externalUid,'uid-a');
});

test('端到端（假桥接）：推送 → 幂等 → 外部改动拉回；写入失败要如实报错',async()=>{
 const apple=fakeApple();
 const {store,ctx}=await seed({records:[{id:'e1',data:{title:'与示例科技对齐',startDate:'2026-10-13T18:00+08:00',endDate:'2026-10-13T19:00+08:00',eventType:'meeting'}}]});
 const first=await runAppleSync({store,ctx,apple,config:{}});
 assert.equal(first.plan.pushCreate,1);
 assert.equal(first.errors.length,0);
 assert(store.get(ctx,'e1').data.externalUid,'推送后要保存回外部 uid');
 assert(store.get(ctx,'e1').data.externalFingerprint,'推送后要保存回内容指纹');
 const second=await runAppleSync({store,ctx,apple,config:{}});
 assert.equal(second.plan.pushCreate+second.plan.pushUpdate+second.plan.pullCreate+second.plan.pullUpdate,0,'第二次同步应当是空操作（幂等）');
 // 外部改名 → 拉回
 const uid=store.get(ctx,'e1').data.externalUid;
 await apple.writeEvent({calendar:'个人工作台',uid,title:'与示例科技对齐（外部改名）',start:'2026-10-13T18:00:00',end:'2026-10-13T19:00:00'});
 const third=await runAppleSync({store,ctx,apple,config:{}});
 assert.equal(third.plan.pullUpdate,1);
 assert.equal(store.get(ctx,'e1').data.title,'与示例科技对齐（外部改名）');
 // 权限失败：必须报错，不能假装同步成功
 const denied=fakeApple({writeError:'没有「日历」的自动化权限。'});
 const {store:store2,ctx:ctx2}=await seed({records:[{id:'e9',data:{title:'写不进去',startDate:'2026-10-13'}}]});
 const failed=await runAppleSync({store:store2,ctx:ctx2,apple:denied,config:{}});
 assert.equal(failed.actions.push.length,0);
 assert.equal(failed.errors.length,1);
 assert.match(failed.errors[0].reason,/权限/);
 assert.equal(store2.get(ctx2,'e9').data.externalUid,undefined,'失败时不能写外部字段');
});

test('同步结果都能按记录编号撤销（走的是 draft → commit，不是直写）',async()=>{
 const apple=fakeApple();
 const {store,ctx}=await seed({records:[{id:'e1',data:{title:'可撤销',startDate:'2026-10-13'}}]});
 const result=await runAppleSync({store,ctx,apple,config:{}});
 assert.equal(result.plan.pushCreate,1);
 const before=store.get(ctx,'e1').data.externalUid;
 assert(before);
 // 回执存在 → 可以走既有 undo 路径
 const receipts=store.db.prepare('SELECT key FROM receipts').all().map(row=>row.key);
 assert(receipts.some(key=>String(key).startsWith('apple-push:')),'同步写入必须留下记录编号');
 const undo=store.undoDraft(ctx,receipts.find(key=>String(key).startsWith('apple-push:')));
 assert(undo?.id,'记录编号能生成撤销待确认的改动');
});

test('定时事务没有结束时间时，推送到日历默认给 1 小时（不能是零长度事件）',async()=>{
 const apple=fakeApple();
 const {store,ctx}=await seed({records:[{id:'e1',data:{title:'与示例客户董事长会面',startDate:'2026-10-12T18:00+08:00',eventType:'meeting'}}]});
 await runAppleSync({store,ctx,apple,config:{},mode:'push'});
 const pushed=apple.store.events[0];
 assert.equal(pushed.start,'2026-10-12T18:00:00');
 assert.equal(pushed.end,'2026-10-12T19:00:00','没有结束时间时默认 +1 小时');
 assert.equal((await import('../src/apple-sync.mjs')).addHour('2026-10-12T23:30:00'),'2026-10-13T00:30:00','跨天也要对');
});
