import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {buildShell} from '../prototype/build-shell.mjs';
import {mountKnowledge,verifyLabel} from '../prototype/knowledge-view.mjs';

// PRD v1.0 §长期记忆 / v1.3 CH-05：记忆引用与 AI 推断单独更新，不得让未核对来源的引用看起来已经核实。
const shell=()=>new JSDOM(buildShell(readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8')));
function store(){
 const instance=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const commit=(id,data,revision)=>{const changes=[revision?{op:'update',id,expectedRevision:revision,data}:{op:'create',id,kind:'memoryRef',data}];const batch=instance.draft(ctx,{title:'记忆',changes});return instance.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()})};
 return {instance,ctx,commit};
}
test('an unrecorded memory reference is shown as 未核对来源, never as verified',()=>{
 assert.equal(verifyLabel(undefined),'未核对来源');
 assert.equal(verifyLabel({}),'未核对来源');
 assert.equal(verifyLabel({status:'verified',checkedAt:'2026-10-20T03:00:00Z'}),'已核对来源 2026-10-20');
 assert.equal(verifyLabel({status:'missing',checkedAt:'2026-10-20T03:00:00Z'}),'来源中未找到 2026-10-20');
 assert.equal(verifyLabel({status:'unverifiable',checkedAt:'2026-10-20T03:00:00Z'}),'无法核对来源 2026-10-20');
});
test('the knowledge page distinguishes 未核对来源, 已核对来源, 来源中未找到 and 无法核对来源',()=>{
 const {instance,ctx,commit}=store();
 const dom=shell(),document=dom.window.document;
 try{
  commit('m1',{title:'未核对来源引用',provider:'user',reference:'user.md#a',content:'甲'});
  commit('m2',{title:'已核对来源引用',provider:'user',reference:'user.md#b',content:'乙',verification:{status:'verified',checkedAt:'2026-10-20T03:00:00Z'}});
  commit('m3',{title:'缺失引用',provider:'workspace',reference:'doc://none',content:'丙',verification:{status:'missing',checkedAt:'2026-10-20T03:00:00Z'}});
  commit('m4',{title:'不可核对来源引用',provider:'workspace',reference:'doc://x',content:'丁',verification:{status:'unverifiable',checkedAt:'2026-10-20T03:00:00Z',note:'检索被拒绝'}});
  const items=instance.list(ctx,{includeArchived:false});
  const view=mountKnowledge(document,items,'memory',{});
  try{
   const cards=[...document.querySelectorAll('#knowbody .resource')].map(node=>node.textContent);
   assert.equal(cards.length,4);
   assert.match(cards.find(text=>text.includes('未核对来源引用')),/未核对来源/);
   assert.doesNotMatch(cards.find(text=>text.includes('未核对来源引用')),/已核对来源/,'没有核对来源记录的引用不得显示为已核对来源');
   assert.match(cards.find(text=>text.includes('已核对来源引用')),/已核对来源 2026-10-20/);
   assert.match(cards.find(text=>text.includes('缺失引用')),/来源中未找到/);
   assert.match(cards.find(text=>text.includes('不可核对来源引用')),/无法核对来源/);
   assert.match(document.querySelector('#knowbody .notice').textContent,/由 Agent 用记忆工具去来源里实际核对/);
   assert.match(document.querySelector('#knowbody .notice').textContent,/"没核对过"不等于来源有效/);
  }finally{view.dispose()}
 }finally{instance.close();dom.window.close()}
});
test('verification results are validated so a fabricated status cannot be stored',()=>{
 const {instance,ctx}=store();
 try{
  const draft=data=>instance.draft(ctx,{title:'记忆',changes:[{op:'create',id:'m',kind:'memoryRef',data:{title:'引用',provider:'user',reference:'user.md#a',content:'甲',...data}}]});
  const cases=[
   [{status:'ok',checkedAt:'2026-10-20'},/核对来源的状态只能是/],
   [{status:'verified'},/核对时间/],
   [{status:'verified',checkedAt:''},/核对时间/],
   [{status:'verified',checkedAt:'2026-10-20',extra:1},/未知项/],
   [{status:'verified',checkedAt:'2026-10-20',note:'x'.repeat(201)},/核对来源的说明过长/],
  ];
  for(const [verification,expected] of cases){
   const batch=draft({verification});
   assert.throws(()=>instance.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()}),expected,'非法核对来源结果必须被拒绝：'+JSON.stringify(verification));
  }
  const ok=draft({verification:{status:'verified',checkedAt:'2026-10-20T03:00:00Z',note:'在 USER.md 中找到'}});
  instance.commit(ctx,{batchId:ok.id,revision:1,key:'ok'});
  assert.equal(instance.get(ctx,'m').data.verification.status,'verified');
 }finally{instance.close()}
});

test('the record detail states the verification result instead of always claiming it is unverified',async()=>{
 const {instance,ctx,commit}=store();
 const dom=shell(),document=dom.window.document;
 try{
  commit('m1',{title:'未核对来源',provider:'user',reference:'user.md#a',content:'甲'});
  commit('m2',{title:'已验证',provider:'user',reference:'user.md#b',content:'乙',verification:{status:'verified',checkedAt:'2026-10-20T03:00:00Z'}});
  commit('m3',{title:'失效',provider:'user',reference:'user.md#c',content:'丙',verification:{status:'missing',checkedAt:'2026-10-20T03:00:00Z'}});
  const {createRecordDetail}=await import('../prototype/record-detail.mjs');
  const detail=createRecordDetail(document,async action=>action==='get'?{item:instance.get(ctx,action==='get'?'m1':'m1')}:{});
  // 直接用真实数据驱动三次详情渲染
  // 断言只针对「核验：」这一行状态：操作按钮上出现「标记为已核对来源」是正常的，不算状态谎报。
  const statusLine=()=>{
   const node=[...document.querySelectorAll('#detailbody p')].find(paragraph=>paragraph.textContent.startsWith('核对来源：'));
   return node?node.textContent.trim():'';
  };
  for(const [id,expected,forbidden] of [['m1',/^核对来源：未核对来源$/,/已核对来源/],['m2',/^核对来源：已核对来源 2026-10-20$/,/未核对来源/],['m3',/^核对来源：来源中未找到 2026-10-20$/,/未核对来源/]]){
   const real=createRecordDetail(document,async(action,body)=>action==='get'?{item:instance.get(ctx,body.id)}:{});
   await real.open(id);await new Promise(resolve=>setImmediate(resolve));
   const line=statusLine();
   assert(line,'详情必须显示核对来源状态行：'+id);
   assert.match(line,expected,'详情必须给出真实核对来源状态：'+id);
   assert.doesNotMatch(line,forbidden,'状态行不得谎报核对来源结果：'+id);
  }
  void detail;
 }finally{instance.close();dom.window.close()}
});

test('the user can record a verification result from the detail without an Agent',async()=>{
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const dom=shell(),document=dom.window.document;
 const item={id:'m1',kind:'memoryRef',revision:3,archived:false,data:{title:'引用',provider:'user',reference:'user.md#a',content:'甲'}};
 const calls=[];
 const send=async(action,data)=>{calls.push({action,data});
  if(action==='get')return {item};
  if(action==='draft')return {id:'b7'};
  throw Error(action);
 };
 let opened=null;
 const detail=createRecordDetail(document,send,{notify:()=>{},openBatch:id=>{opened=id}});
 try{
  await detail.open('m1');
  await new Promise(resolve=>setImmediate(resolve));
  const buttons=[...document.querySelectorAll('#detailbody [data-verify]')];
  assert.equal(buttons.length,3,'未核对来源的引用应提供三种核对来源结果');
  assert(buttons.some(button=>button.dataset.verify==='verified'));
  buttons.find(button=>button.dataset.verify==='verified').click();
  await new Promise(resolve=>setImmediate(resolve));
  const draft=calls.find(call=>call.action==='draft');
  assert(draft,'必须走待确认的改动流程，不能直接改记录');
  assert.equal(draft.data.changes[0].op,'update');
  assert.equal(draft.data.changes[0].expectedRevision,3,'必须带当前版本，避免覆盖并发修改');
  assert.equal(draft.data.changes[0].data.verification.status,'verified');
  assert.match(draft.data.changes[0].data.verification.checkedAt,/^\d{4}-\d{2}-\d{2}T/,'必须记录核对来源时间');
  assert.match(draft.data.changes[0].data.verification.note,/由用户在界面确认/,'必须标明是谁的核对来源，不得冒充工具核对来源');
  assert.equal(draft.data.changes[0].data.provider,'user','核对来源不得丢失原有引用字段');
  assert.equal(opened,'b7','生成待确认的改动后应打开让用户确认');
 }finally{detail.dispose();dom.window.close()}
});
test('a recorded status is not offered again, and unknown statuses stay untouched',async()=>{
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const dom=shell(),document=dom.window.document;
 const item={id:'m2',kind:'memoryRef',revision:1,archived:false,data:{title:'引用',provider:'user',reference:'x',content:'乙',verification:{status:'verified',checkedAt:'2026-10-20T00:00:00Z'}}};
 const detail=createRecordDetail(document,async action=>action==='get'?{item}:{id:'b'},{notify:()=>{}});
 try{
  await detail.open('m2');
  await new Promise(resolve=>setImmediate(resolve));
  const buttons=[...document.querySelectorAll('#detailbody [data-verify]')].map(button=>button.dataset.verify);
  assert(!buttons.includes('verified'),'已核对来源的选项不应重复提供');
  assert.deepEqual(buttons.sort(),['missing','unverifiable']);
 }finally{detail.dispose();dom.window.close()}
});

// ── 2026-10-14：用户自己点的「标记为已核对来源」必须**直接生效** ──────────────
// 独立走查 F13 ③：原来它生成一条待确认的改动丢进收件箱 —— 等于让用户对自己刚做的决定
// 再点一次头，还要多走两步。契约②写死了：**自己的操作直接生效 + 左下可撤销**，
// 只有 AI 提议才进收件箱。这条测试锁住"有撤销条（batch.apply）时必须走直接生效"。
test('a verification the user records themselves applies directly, with undo, not via the inbox',async()=>{
 const {createRecordDetail}=await import('../prototype/record-detail.mjs');
 const dom=shell(),document=dom.window.document;
 const item={id:'m1',kind:'memoryRef',revision:3,archived:false,data:{title:'引用',provider:'user',reference:'user.md#a',content:'甲'}};
 const applied=[],drafted=[];
 const send=async(action,data)=>{if(action==='get')return {item};if(action==='draft'){drafted.push(data);return {id:'b7'}};throw Error(action)};
 const detail=createRecordDetail(document,send,{notify:()=>{},batch:{apply:async(text,changes)=>applied.push({text,changes})}});
 try{
  await detail.open('m1');
  await new Promise(resolve=>setImmediate(resolve));
  const button=[...document.querySelectorAll('#detailbody [data-verify]')].find(node=>node.dataset.verify==='verified');
  assert.ok(button,'未核对来源的引用应提供核对按钮');
  button.click();
  for(let i=0;i<20&&!applied.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(applied.length,1,'自己点的核对必须直接生效（一次 apply）');
  assert.equal(drafted.length,0,'不得再生成一条待确认的改动 —— 同一件事不该让用户点两次头');
  assert.equal(applied[0].changes[0].data.verification.status,'verified');
  assert.match(applied[0].changes[0].data.verification.note,/由用户在界面确认/,'仍然要标明是用户核对的');
 }finally{detail.dispose();dom.window.close()}
});
