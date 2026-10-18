import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {HeartbeatStore,FAILURE_ALERT_THRESHOLD} from '../src/heartbeat-store.mjs';
import {runHeartbeat,HEARTBEAT_RULES} from '../src/heartbeat.mjs';

/** 主动做事（F19–F22 判定 + F24 留痕）的验收：
 *  - 四类判定各自能产出"值得找你"与"为什么没打扰你"；
 *  - 留痕如实：看到什么、为什么没打扰、跑没跑成，全部来自真实数据，不编；
 *  - 连续失败要出告警（唯一允许的打扰例外）；
 *  - 不许声称"已在定时运行"。 */
const ctx={workspace:'w',actor:'u',canWrite:true};
const NOW=new Date('2026-10-13T09:00:00Z');

function setup(){
 const store=new WorkstationStore(':memory:');
 const heartbeat=new HeartbeatStore(store);
 const create=(title,changes)=>{const batch=store.draft(ctx,{title,changes});store.commit(ctx,{batchId:batch.id,revision:batch.revision,key:title+':'+Math.random()});};
 return {store,heartbeat,create};
}
const titles=list=>list.map(item=>item.title).sort();

test('守承诺：今天到期的算"值得找你"，七天后的写清"为什么没打扰"',()=>{
 const {store,heartbeat,create}=setup();
 try{
  create('任务',[
   {op:'create',id:'due-today',kind:'task',data:{title:'交样机',status:'in_progress',dueDate:'2026-10-13'}},
   {op:'create',id:'due-later',kind:'task',data:{title:'季度复盘',status:'todo',dueDate:'2026-10-20'}},
   {op:'create',id:'waiting',kind:'task',data:{title:'等对方给参数',status:'waiting',dueDate:'2026-10-15',blockedReason:'等对方提供开发板参数'}},
  ]);
  const record=runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES.filter(rule=>rule.id==='commitments')});
  assert.equal(record.outcome,'ok');
  assert.equal(record.errors.length,0);
  const told=titles(record.candidates);
  assert(told.includes('交样机'),'今天到期的必须说出来');
  assert(told.includes('等对方给参数'),'别人在等你且三天内到期，必须说出来');
  assert(!told.includes('季度复盘'),'还早的不许打扰');
  const quiet=record.silenced.find(item=>item.title==='季度复盘');
  assert.equal(quiet.why,'还有 7 天，现在说太早','沉默理由必须具体，不能只写"暂不提醒"');
  assert(record.looked.length>0,'留痕必须写出这次看了什么');
  const run=heartbeat.record(ctx,record);
  assert.equal(heartbeat.status(ctx).lastSuccessAt,run.startedAt);
 }finally{store.close()}
});

test('盯依赖：依赖解锁才说话，还在等就写清在等谁',()=>{
 const {store,create}=setup();
 try{
  create('任务',[
   {op:'create',id:'done-dep',kind:'task',data:{title:'拿到样片',status:'done'}},
   {op:'create',id:'open-dep',kind:'task',data:{title:'排产',status:'in_progress'}},
   {op:'create',id:'unblocked',kind:'task',data:{title:'开始验证',status:'waiting',dependsOn:['done-dep']}},
   {op:'create',id:'still-blocked',kind:'task',data:{title:'整机联调',status:'waiting',dependsOn:['open-dep']}},
  ]);
  const record=runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES.filter(rule=>rule.id==='dependencies')});
  assert.equal(record.outcome,'ok');
  const told=titles(record.candidates);
  assert(told.includes('开始验证'),'依赖全部完成必须说"可以继续"');
  assert(!told.includes('整机联调'));
  assert.match(record.silenced.find(item=>item.title==='整机联调').why,/还在等 排产/,'必须说清在等谁');
  assert(record.candidates.find(item=>item.title==='开始验证').why.includes('依赖已解锁'));
 }finally{store.close()}
});

test('做简报：有新信息必须带真实来源与时间；没有新信息不许硬凑',()=>{
 const {store,create}=setup();
 try{
  create('材料',[{op:'create',id:'proj-1',kind:'project',data:{title:'存算一体'}}]);
  create('材料',[{op:'create',id:'topic-1',kind:'topic',data:{title:'3D 存算一体'}}]);
  create('材料',[{op:'create',id:'art-1',kind:'artifact',data:{title:'路演纪要',path:'会议/纪要.md',projectId:'proj-1'}}]);
  const withMaterial=runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES.filter(rule=>rule.id==='briefs'),since:'2026-10-01T00:00:00Z'});
  const brief=withMaterial.candidates.find(item=>item.rule==='做简报');
  assert(brief,'有新材料时必须产出');
  assert(brief.source?.id==='art-1'&&brief.source?.title==='路演纪要','简报必须能指回来源');
  assert(brief.source.at,'来源必须带它自己的记录时间（不编抓取时间）');
  // 这里的 since 必须**相对**于材料的真实写入时间，不能写死日期：
  // 实体的 at 是真实时钟（store 写入时打），写死日期会随墙上时钟推移而失效 ——
  // 10-13 17:45 写这条测试时它通过，次日 09:21 就必然挂（我实测到了）。
  // 语义不变：把基线设在材料到达之后，等于"这份材料上一轮简报已经报过了"。
  const materialAt=store.get(ctx,'art-1').at;
  const afterMaterial=new Date(Date.parse(materialAt)+3600000).toISOString();
  const noMaterial=runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES.filter(rule=>rule.id==='briefs'),since:afterMaterial});
  assert.equal(noMaterial.candidates.filter(item=>item.rule==='做简报').length,0);
  assert.match(noMaterial.silenced.find(item=>item.rule==='做简报').why,/没有新材料/);
 }finally{store.close()}
});

test('复核旧判断：到了你定的复核时间要说；待核对但没新证据就不要打扰',()=>{
 const {store,create}=setup();
 try{
  create('判断',[
   {op:'create',id:'j-due',kind:'judgment',data:{title:'这家能按期交付',validFrom:'2026-09-01',reviewBy:'2026-10-13',status:'current',evidence:[{kind:'note',ref:'会议',quote:'对方说 10 月能交'}]}},
   {op:'create',id:'j-checking',kind:'judgment',data:{title:'产能是否够',validFrom:'2026-09-20',status:'checking',evidence:[{kind:'note',ref:'口述',quote:'产能待确认'}]}},
  ]);
  const record=runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES.filter(rule=>rule.id==='reviews')});
  const told=titles(record.candidates);
  assert(told.includes('这家能按期交付'),'到了复核时间必须说');
  const dueItem=record.candidates.find(item=>item.title==='这家能按期交付');
  assert.equal(dueItem.subjectId,'j-due','提醒必须能点回到那条判断');
  assert.match(dueItem.why,/复核时间/,'必须写清为什么现在告诉你');
  assert(!told.includes('产能是否够'),'没有新证据的待核对项不许打扰');
  assert.match(record.silenced.find(item=>item.title==='产能是否够').why,/还没有新证据/);
 }finally{store.close()}
});

test('留痕如实：看到什么、值得找你、没打扰你，三样都在且数目自洽',()=>{
 const {store,create}=setup();
 try{
  create('任务',[{op:'create',id:'due-today',kind:'task',data:{title:'交样机',status:'todo',dueDate:'2026-10-13'}}]);
  const record=runHeartbeat({store,ctx,now:NOW});
  assert.equal(record.trigger,'manual');
  assert.equal(record.scheduled,false,'本批只有手动触发，记录里不许写成已定时');
  assert.match(record.scheduledNote,/不会自己醒/);
  assert(record.looked.length>0);
  assert.equal(record.counts.looked,record.looked.length);
  assert.equal(record.counts.candidates,record.candidates.length);
  assert.equal(record.counts.silenced,record.silenced.length);
  for(const item of [...record.candidates,...record.silenced]){
   assert(item.rule,'每条都要写明是哪一类判定');
   assert(item.what,'每条都要写"看到什么"');
   assert(item.why,'每条都要写理由（值得找你还是不打扰）');
  }
 }finally{store.close()}
});

test('失败会留痕并告警：连续两次没跑成必须报警，且不掩盖跑成的那部分',()=>{
 const {store,heartbeat,create}=setup();
 try{
  create('任务',[{op:'create',id:'due-today',kind:'task',data:{title:'交样机',status:'todo',dueDate:'2026-10-13'}}]);
  const broken={id:'broken',label:'坏掉的判定',run(){throw new Error('读取失败：示例故障')}};
  const rules=[...HEARTBEAT_RULES.filter(rule=>rule.id==='commitments'),broken];
  const first=runHeartbeat({store,ctx,now:NOW,rules});
  assert.equal(first.outcome,'failed','有判定没跑成，整次就不能算成功');
  assert.equal(first.errors.length,1);
  assert.match(first.errors[0].message,/示例故障/);
  assert(first.candidates.length>0,'一个判定坏了，其他判定看到的东西不能丢');
  heartbeat.record(ctx,first);
  assert.equal(heartbeat.status(ctx).alert,null,'只失败一次还不告警');
  const second=runHeartbeat({store,ctx,now:NOW,rules});
  heartbeat.record(ctx,second);
  const status=heartbeat.status(ctx);
  assert.equal(status.consecutiveFailures,2);
  assert(status.alert,'连续失败达到阈值必须告警');
  assert.match(status.alert.reason,/连续 2 次没跑成/);
  assert(status.alert.detail.some(text=>/示例故障/.test(text)),'告警要带上真实原因');
  assert.equal(FAILURE_ALERT_THRESHOLD,2);
  // 恢复一次之后告警要消失（不许一直挂着）
  heartbeat.record(ctx,runHeartbeat({store,ctx,now:NOW,rules:HEARTBEAT_RULES}));
  assert.equal(heartbeat.status(ctx).alert,null);
  assert(heartbeat.status(ctx).lastSuccessAt);
 }finally{store.close()}
});
