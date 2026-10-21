import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';
import {exportViewMarkdown, validateViewAnalysis} from '../src/view-spec.mjs';

function setup(){
  const store=new WorkstationStore(':memory:');
  const ctx={workspace:'w',actor:'test',canWrite:true};
  const b=store.draft(ctx,{title:'seed',changes:[
    {op:'create',id:'p',kind:'project',data:{title:'项目P'}},
    {op:'create',id:'j',kind:'judgment',data:{title:'判断J',projectId:'p',evidence:[{kind:'note',ref:'手记@1',quote:'一句话依据'}],validFrom:'2026-10-18',uncertainty:'未核对',status:'current',origin:'user'}}
  ]});
  store.commit(ctx,{batchId:b.id,revision:1,key:'seed'});
  const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/w'}})},workspaceRegistry:{resolveByPath:async()=>({id:'w'})},approval:{request:async()=>'allowed-once'},allowedWorkspaces:['w']});
  return {store,ctx,adapter,exec:{agent:{id:'s'},callId:'c'}};
}

test('AI 解读：必须引用 dataRefs；合法解读随 view 保存，导出也带上', async () => {
  const {store,ctx,adapter,exec}=setup();
  try{
    const preview=(await adapter.run({action:'view_preview',template:'risk-matrix',subjectId:'p'},exec)).view;
    const ref=preview.dataRefs.find(r=>r.startsWith('j'));
    assert.ok(ref,'预置判断应在 dataRefs 里');
    const analysis={summary:'当前判断只有一条口头依据。',findings:[{ref,text:'判断J 仍待核对'}],uncertainty:'未做第三方验证'};
    const saved=await adapter.run({action:'view_save',template:'risk-matrix',subjectId:'p',analysis},exec);
    const batch=store.preview(ctx,saved.batch.id);
    const viewDraft=batch.changes[0].data;
    assert.deepEqual(viewDraft.analysis,analysis);
    const md=exportViewMarkdown({...preview,analysis}).markdown;
    assert.match(md,/## AI 解读/);
    assert.match(md,/当前判断只有一条口头依据/);
  } finally { store.close(); }
});

test('AI 解读拒绝编造引用 / 超长 / 无内容', async () => {
  assert.throws(()=>validateViewAnalysis({summary:'x',findings:[{ref:'not-in-refs@1',text:'编造'}]},['p@1'],'ai'),{code:'INVALID'});
  assert.throws(()=>validateViewAnalysis({summary:'x'.repeat(601)},['p@1'],'ai'),{code:'INVALID'});
  assert.throws(()=>validateViewAnalysis({},['p@1'],'ai'),{code:'INVALID'});
  assert.throws(()=>validateViewAnalysis({summary:'x'},['p@1'],'user'),{code:'INVALID'});
});

test('编辑 AI 解读：直接提交，返回最新视图（不进收件箱）', async () => {
 const {store,ctx,adapter,exec}=setup();
 try{
  const preview=(await adapter.run({action:'view_preview',template:'risk-matrix',subjectId:'p'},exec)).view;
  const ref=preview.dataRefs.find(r=>r.startsWith('j'));
  const first={summary:'第一版',findings:[{ref,text:'待核对'}],uncertainty:'无'};
  const saved=await adapter.run({action:'view_save',template:'risk-matrix',subjectId:'p',analysis:first},exec);
  const committed=store.commit(ctx,{batchId:saved.batch.id,revision:saved.batch.revision,key:'k1'});
  const viewId=committed.after[0].id;
  const {updateViewAnalysis}=await import('../src/view-spec.mjs');
  const next={summary:'第二版（已编辑）',findings:[{ref,text:'已核对一条'}],uncertainty:'仍需第三方验证'};
  const updated=updateViewAnalysis({store,ctx,viewId,revision:committed.after[0].revision,analysis:next});
  assert.equal(updated.item.data.analysis.summary,'第二版（已编辑）');
  assert.equal(store.inbox(ctx,{status:'draft'}).length,0,'编辑应直接生效，不留在收件箱');
 } finally { store.close(); }
});
