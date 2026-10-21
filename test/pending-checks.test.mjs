import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {buildPendingChecks} from '../src/pending-checks.mjs';

const ctx={workspace:'trusted',actor:'audit',canWrite:false};
const seed=store=>{
 const c={workspace:'trusted',actor:'audit',canWrite:true};
 const write=changes=>{const d=store.draft(c,{title:'seed',changes});store.commit(c,{batchId:d.id,revision:1,key:'k'+Math.random()})};
 write([{op:'create',id:'org',kind:'organization',data:{title:'示例科技'}}]);
 write([{op:'create',id:'person',kind:'person',data:{title:'张工'}}]);
 write([{op:'create',id:'p1',kind:'project',data:{title:'示例产品',partnerId:'org',ownerId:'person'}}]);
 write([{op:'create',id:'j1',kind:'judgment',data:{title:'合作结构模式有风险',status:'checking',projectId:'p1',validFrom:'2026-09-01',reviewBy:'2026-10-20',uncertainty:'尚未核对对方已有的案例记录',evidence:[{kind:'file',ref:'纪要.md#3',quote:'示例依据：合作结构需要分阶段验证'}]}}]);
 write([{op:'create',id:'j2',kind:'judgment',data:{title:'带宽数字是对方自述',status:'current',validFrom:'2026-09-02',uncertainty:'四条成本数字未经第三方验证',evidence:[{kind:'message',ref:'msg-1',quote:'对方说 4W'}]}}]);
};
test('every pending check answers who/what/done/why with real sources',()=>{
 const store=new WorkstationStore(':memory:');seed(store);
 try{
  const items=buildPendingChecks({store,ctx,now:new Date('2026-10-18T02:00:00Z'),limit:5});
  assert.equal(items.length,2);
  const first=items[0];
  assert.equal(first.judgmentId,'j1','待核对排前面');
  assert.equal(first.askWho,'张工','有负责人就用记录里的负责人');
  assert.equal(first.partnerTitle,undefined,'不输出多余字段');
  assert.match(first.askWhat,/案例记录/);
  assert.match(first.whatCountsAsDone,/2026-10-20/,'有复核日期就写进完成标准');
  assert.match(first.whyNow,/待核对/);
  assert.equal(first.evidenceRef,'纪要.md#3','要带得出处');
  const second=items[1];
  assert.match(second.whyNow,/不确定性/,'写着不确定却当现行结论在用，理由要说清');
  assert.equal(second.askWho,null,'没有负责人时不编');
  assert.match(second.askWhoLabel,/还没记录找谁核/);
  assert.deepEqual(JSON.parse(JSON.stringify(items)),items,'无损 JSON');
 }finally{store.close()}
});
test('no checking judgments means no invented follow-ups',()=>{
 const store=new WorkstationStore(':memory:');
 try{assert.deepEqual(buildPendingChecks({store,ctx}),[])}finally{store.close()}
});
