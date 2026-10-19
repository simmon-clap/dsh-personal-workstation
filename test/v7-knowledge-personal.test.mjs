import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from '../dev-deps.mjs';import {buildShell} from '../prototype/build-shell.mjs';import {mountKnowledge,mountPersonal} from '../prototype/knowledge-view-v2.mjs';
import {eventModel,compareEvents,eventDayKey} from '../prototype/event-model.mjs';
const doc=()=>new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8')));
test('knowledge views render only matching records and dispose handlers',()=>{const dom=doc(),d=dom.window.document,calls=[];const items=[{id:'t',kind:'topic',data:{title:'议题 <一>',content:'内容'}},{id:'a',kind:'artifact',data:{title:'资料',description:'来源'}},{id:'m',kind:'memoryRef',data:{title:'记忆',provider:'Mnemon'}}];const v=mountKnowledge(d,items,'topics',{open:id=>calls.push(id)});try{assert.match(d.querySelector('#knowbody').textContent,/议题 <一>/);assert.doesNotMatch(d.querySelector('#knowbody').textContent,/资料/);d.querySelector('[data-id="t"]').click();assert.deepEqual(calls,['t']);v.dispose();d.querySelector('[data-id="t"]')?.click();assert.deepEqual(calls,['t']);mountKnowledge(d,items,'brief');assert.match(d.querySelector('#knowbody').textContent,/还没有登记简报/,'简报页只显示真实登记的简报');assert.doesNotMatch(d.querySelector('#knowbody').textContent,/议题 <一>/,'简报页不得串入研究议题');}finally{dom.window.close()}});
test('personal tabs separate internal event types and escape records',()=>{const dom=doc(),d=dom.window.document,calls=[];const items=[{id:'c',kind:'event',data:{title:'会议 <A>',eventType:'meeting',startDate:'2026-01-02T09:00:00+08:00',location:'室内'}},{id:'o',kind:'event',data:{title:'事务',eventType:'other',startDate:'2026-01-02'}},{id:'r',kind:'event',data:{title:'行程',eventType:'travel',startDate:'2026-01-03T09:00:00+08:00'}}];const v=mountPersonal(d,items,'calendar',{open:id=>calls.push(id)});try{assert.match(d.querySelector('#personalbody').textContent,/会议 <A>/);assert.match(d.querySelector('#personalbody').textContent,/事务/);assert.doesNotMatch(d.querySelector('#personalbody').textContent,/行程/);d.querySelector('[data-id="c"]').click();assert.deepEqual(calls,['c']);v.dispose();mountPersonal(d,items,'travel');assert.match(d.querySelector('#personalbody').textContent,/行程/);assert.doesNotMatch(d.querySelector('#personalbody').textContent,/会议/);}finally{dom.window.close()}});
test('event model derives all-day from date-only and orders across timezone offsets',()=>{const all=eventModel({id:'a',data:{title:'全天',startDate:'2026-01-02'}}),timed=eventModel({id:'b',data:{title:'定时',startDate:'2026-01-02T09:00:00+08:00'}});assert.equal(all.allDay,true);assert.match(all.label,/全天/);assert.equal(timed.allDay,false);
 const events=[{id:'later',data:{startDate:'2026-01-02T02:00:00Z'}},{id:'earlier',data:{startDate:'2026-01-02T09:00:00+08:00'}},{id:'allday',data:{startDate:'2026-01-02'}},{id:'unknown',data:{}}];assert.deepEqual([...events].sort(compareEvents).map(e=>e.id),['allday','earlier','later','unknown']);assert.equal(eventModel({id:'x',data:{}}).instant,Infinity);assert.equal(eventModel({id:'x',data:{}}).dayKey,null);assert.match(eventModel({id:'x',data:{}}).label,/未设置时间/);
 assert.equal(eventModel({id:'a',data:{startDate:'2026-01-02'}}).dayKey,'2026-01-02');{const date=new Date('2026-01-02T09:00:00+08:00');const pad=n=>String(n).padStart(2,'0');const localDay=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;assert.equal(eventModel({id:'b',data:{startDate:'2026-01-02T09:00:00+08:00'}}).dayKey,localDay,'dayKey 按本机本地日期，不受 CI 时区影响')}assert.equal(eventDayKey(new Date(2026,0,2,23,59)),'2026-01-02');assert.equal(eventDayKey(new Date(2026,0,3,0,0)),'2026-01-03');});

test('task and deliverable dates show up in the calendar view instead of staying invisible',()=>{
 const dom=new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8'))),document=dom.window.document;
 const today=new Date().toISOString().slice(0,10);
 const past='2020-01-01';
 const items=[
  {id:'t1',kind:'task',data:{title:'逾期任务',dueDate:past,status:'in_progress'}},
  {id:'t2',kind:'task',data:{title:'未来的任务',dueDate:'2999-01-01',status:'todo'}},
  {id:'p1',kind:'project',data:{title:'联合验证',deliverables:[{id:'d1',title:'方案定稿',done:false,dueDate:today},{id:'d2',title:'没排期',done:false}]}},
  {id:'e1',kind:'event',data:{title:'周会',startDate:today,eventType:'meeting'}},
 ];
 const view=mountPersonal(document,items,'calendar',{open:()=>{}});
 try{
  const due=document.querySelector('#personalbody [data-due]');
  assert(due,'日程视图必须包含到期与逾期区');
  assert.match(due.textContent,/逾期任务/,'任务截止日期必须出现在日程里');
  assert.match(due.textContent,/方案定稿/,'交付项的截止日期也必须出现');
  assert.match(due.textContent,/已逾期/);
  assert.match(due.textContent,/1 项已逾期/);
  assert.doesNotMatch(due.textContent,/没排期/,'没填日期就不该出现在到期区');
 }finally{view.dispose();dom.window.close()}
});
test('the due section says so explicitly when no dates are set',()=>{
 const dom=new JSDOM(buildShell(readFileSync(new URL('../prototype/frozen/workbench-v7.html',import.meta.url),'utf8'))),document=dom.window.document;
 const view=mountPersonal(document,[{id:'e1',kind:'event',data:{title:'周会',startDate:'2026-01-01',eventType:'meeting'}}],'calendar',{open:()=>{}});
 try{
  const due=document.querySelector('#personalbody [data-due]');
  assert.match(due.textContent,/还没有填写日期/,'没有日期时要说清楚原因，而不是沉默');
 }finally{view.dispose();dom.window.close()}
});
