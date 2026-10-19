import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {SpeakStore} from '../src/speak-store.mjs';
import {BUDGET_INITIAL,budgetOf,decideLevel,stageOf,weeklySecondaryLimit,inQuietWindow,metering,speakState,neverSpeak} from '../src/speak.mjs';

/** 批次 8 验收（spec/04 §3）：① 额度初值 40，标"没必要"后 ≤30；② 窗口内零出声；
 *  ③ 二级出声同时满足三条件；④ 标记"该说没说"后门槛下调一档。
 *  外加两条不可让渡：额度不许靠"憋着"涨；通道没核实不许声称已能推送。 */
const ctx={workspace:'w',actor:'u',canWrite:true};
const workday=new Date('2026-10-13T10:00:00');   // 周二上午（非免打扰）
const night=new Date('2026-10-13T23:30:00');     // 周二深夜（免打扰）
const weekend=new Date('2026-10-17T10:00:00');   // 周六上午（免打扰）

const candidateWith=(overrides={})=>({rule:'守承诺',subjectId:'t1',title:'交样机',what:'交付日期 2026-10-13',
 why:'今天到期',level:2,commitment:true,fresh:true,days:0,...overrides});

test('额度：初值 40；标"没必要"后降到 30 及以下；长时间不出声不涨',()=>{
 assert.equal(BUDGET_INITIAL,40);
 assert.equal(budgetOf([]),40);
 const afterUnnecessary=budgetOf([{kind:'unnecessary'}]);
 assert.equal(afterUnnecessary,30);
 assert(afterUnnecessary<=30,'标"没必要"后必须降到 30 及以下');
 assert.equal(budgetOf([{kind:'followed'}]),48);
 assert.equal(budgetOf([{kind:'noted'}]),42);
 assert.equal(budgetOf([{kind:'ignored'}]),37);
 // 什么都不回应（长时间不出声）→ 不变
 assert.equal(budgetOf([{kind:'missed'}]),40,'该说没说改的是门槛，不是额度');
 assert.equal(budgetOf([]),40);
 // 边界：不会超出 0–100
 assert.equal(budgetOf(Array.from({length:40},()=>({kind:'unnecessary'}))),0);
 assert.equal(budgetOf(Array.from({length:40},()=>({kind:'followed'}))),100);
});

test('阶段与二级每周上限按 03 §11 的公式来',()=>{
 assert.equal(stageOf(29),'陌生期');
 assert.equal(stageOf(40),'试用期');
 assert.equal(stageOf(70),'信任期');
 assert.equal(weeklySecondaryLimit(40),2);
 assert.equal(weeklySecondaryLimit(70),3);
 assert.equal(weeklySecondaryLimit(100),5);
 assert.equal(weeklySecondaryLimit(0),1);
});

test('免打扰：22:00–08:00 与周末一律不出二级（窗口内零出声）',()=>{
 assert(!inQuietWindow(workday));
 assert(inQuietWindow(night));
 assert(inQuietWindow(weekend));
 for(const now of [night,weekend]){
  const decision=decideLevel(candidateWith(),{budget:40,now});
  assert.equal(decision.level,1,'窗口内不许出二级');
  assert.match(decision.why,/免打扰/);
 }
 assert.equal(decideLevel(candidateWith(),{budget:40,now:workday}).level,1,'通道没核实 → 二级降级为一级');
});

test('二级出声的三条件：缺任何一条都不许出二级',()=>{
 const base={budget:40,now:workday};
 // ① 缺承诺相关
 assert.equal(decideLevel(candidateWith({commitment:false}),base).level,1);
 // ② 缺新的可核对事实
 assert.equal(decideLevel(candidateWith({fresh:false}),base).level,1);
 assert.match(decideLevel(candidateWith({fresh:false}),base).why,/没有新的可核对事实/);
 // ③ 同类这周已经说过
 assert.equal(decideLevel(candidateWith(),{...base,spokenThisWeek:{守承诺:1}}).level,1);
 assert.match(decideLevel(candidateWith(),{...base,spokenThisWeek:{守承诺:1}}).why,/不重复不升级/);
 // 三条都满足、通道也核实了 → 才是二级
 const ready=decideLevel(candidateWith(),{...base,channelReady:true});
 assert.equal(ready.level,2);
 assert.equal(ready.delivery,'feishu');
 // 三条都满足但通道没核实 → 降级为一级，且写明原因（不许说已能推送）
 const degraded=decideLevel(candidateWith(),base);
 assert.equal(degraded.level,1);
 assert.equal(degraded.degraded,true);
 assert.equal(degraded.delivery,'none');
 assert.match(degraded.why,/没有发送代码|未实现发送/,'必须说清发送代码没实现');
 assert.match(degraded.degradation,/未实现发送/);
});

test('通道未核实时：任何地方都不许出现"已推送"的说法',()=>{
 const state=speakState([],{now:workday});
 assert.equal(state.channel.ready,false);
 assert.equal(state.channel.implemented,false,'工作台没有发送代码，必须如实标未实现');
 assert.match(state.channel.note,/不会自己发到飞书/);
 const decision=decideLevel(candidateWith(),{budget:40,now:workday});
 assert.notEqual(decision.delivery,'feishu');
 assert.equal(decision.delivery,'none');
});

test('每周上限用完或陌生期：不许出二级',()=>{
 const used={守承诺:2};
 const decision=decideLevel(candidateWith({rule:'复核旧判断'}),{budget:40,now:workday,spokenThisWeek:used,channelReady:true});
 assert.equal(decision.level,1);
 assert.match(decision.why,/上限 2 次/);
 // 陌生期（额度 <30）只允许"已经错过的事"
 assert.equal(decideLevel(candidateWith({days:1,overdue:false}),{budget:20,now:workday,channelReady:true}).level,1);
 assert.equal(decideLevel(candidateWith({days:-2,overdue:true}),{budget:20,now:workday,channelReady:true}).level,2);
});

test('「该说没说」标记后，该类条件的门槛下调一档',()=>{
 // 还没到期（明天）→ 平时不算"错过就没了"；标记过之后，同一类的门槛放宽一档 → 可以出二级
 // 还有一天＝临期，有承诺＋新事实，本来就够二级；还有两天就不够（要等"该说没说"放宽）
 assert.equal(decideLevel(candidateWith({days:1,overdue:false}),{budget:40,now:workday,channelReady:true}).level,2,'临期且承诺过，够二级');
 assert.equal(decideLevel(candidateWith({days:2,overdue:false}),{budget:40,now:workday,channelReady:true}).level,1,'还早，平时不该出二级');
 const marked=decideLevel(candidateWith({days:2,overdue:false,missed:{守承诺:1}}),{budget:40,now:workday,channelReady:true});
 assert.equal(marked.level,2,'标记"该说没说"之后，同类门槛要放宽一档');
 // 只放宽同类：别的类不受影响
 assert.equal(decideLevel(candidateWith({rule:'盯依赖',days:2,overdue:false,missed:{守承诺:1}}),{budget:40,now:workday,channelReady:true}).level,1);
});

test('永不出声的四类：没有来源、兴趣类、重复、已否决',()=>{
 assert.match(neverSpeak({noSource:true}),/没有来源/);
 assert.match(neverSpeak({interest:true}),/兴趣类/);
 assert.match(neverSpeak({repeated:true}),/重复/);
 assert.match(neverSpeak({rejected:true}),/否决/);
 const decision=decideLevel({rule:'做简报',level:2,noSource:true},{budget:90,now:workday,channelReady:true});
 assert.equal(decision.level,null);
 assert.equal(decision.delivery,'forbidden');
});

test('双向计量：既记说多了，也记该说没说',()=>{
 const meteringResult=metering([{kind:'followed'},{kind:'unnecessary'},{kind:'ignored'},{kind:'missed'}]);
 assert.equal(meteringResult.spoken,3);
 assert.equal(meteringResult.missed,1);
 assert.equal(meteringResult.tooMuchRate,67);   // 2/3
 assert.equal(meteringResult.missedRate,25);    // 1/4
});

test('回应落库：状态能读回额度、阶段与门槛放宽，非法回应被拒',()=>{
 const store=new WorkstationStore(':memory:');
 try{
  const speak=new SpeakStore(store);
  assert.equal(speak.state(ctx).budget,40);
  speak.record(ctx,{kind:'unnecessary',subjectId:'t1',rule:'守承诺'});
  const state=speak.state(ctx);
  assert.equal(state.budget,30);
  assert.equal(state.stage,'试用期');
  speak.record(ctx,{kind:'missed',condition:'守承诺'});
  assert.equal(speak.state(ctx).thresholdShifts['守承诺'],1);
  assert.equal(speak.list(ctx,{}).items.length,2);
  assert.throws(()=>speak.record(ctx,{kind:'乱写'}),{code:'INVALID'});
  assert.throws(()=>speak.record(ctx,{kind:'missed'}),{code:'INVALID'},'该说没说必须指明是哪一类');
 }finally{store.close()}
});
