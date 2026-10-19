import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter,toolDefinition} from '../src/dsh-adapter.mjs';
import {sameSubject,findConflicts,checkCandidates} from '../src/judgment-synthesis.mjs';

const EV=(kind,ref,quote)=>({kind,ref,quote});
const J=(id,title,status,projectId,evidence,uncertainty)=>({id,kind:'judgment',revision:1,archived:false,at:'2026-10-01T00:00:00.000Z',data:{title,status,projectId,evidence,validFrom:'2026-09-30',...(uncertainty?{uncertainty}:{})}});

test('same subject is judged by shared topic words, not by status or punctuation',()=>{
 assert.equal(sameSubject('与示例伙伴的合作真实存在','与示例伙伴的合作并不存在'),true);
 assert.equal(sameSubject('当前方案并不存在（时间安排）','服务器的价格短期接受不了'),false,'不同主题不能硬凑成矛盾');
 assert.equal(sameSubject('对方的性能与成本数字全部是自述','对方的功耗与成本数字是自述'),true);
});

test('conflicts carry both judgments, both sources and a reason',()=>{
 const conflicts=findConflicts([
  J('a','与示例伙伴的合作真实存在','current','p1',[EV('file','纪要.md#3','确认与示例伙伴有合作')]),
  J('b','与示例伙伴的合作并不存在','current','p1',[EV('message','msg-9','示例伙伴方面否认合作')]),
  J('c','手机端短期难变现','current','p1',[EV('note','x','手机端价格敏感')]),
 ]);
 assert.equal(conflicts.length,1);
 assert.equal(conflicts[0].a.id,'a');assert.equal(conflicts[0].b.id,'b');
 assert.match(conflicts[0].reason,/相反结论/);
 assert.equal(conflicts[0].a.evidence[0].ref,'纪要.md#3');
 assert.equal(conflicts[0].b.evidence[0].ref,'msg-9');
});

test('an affirmed candidate contradicts a denied existing judgment',()=>{
 const conflicts=findConflicts([
  J('a','当前方案并不存在','current','p1',[EV('file','纪要.md#2','方案未立项')]),
  J('b','当前方案已经存在','current','p1',[EV('file','纪要.md#5','方案已立项')]),
 ]);
 assert.equal(conflicts.length,1,'「已经存在」与「并不存在」必须判成相反结论');
 assert.match(conflicts[0].reason,/相反结论/);
});

test('an overturned judgment still in use is flagged even when wording is not opposite',()=>{
 const conflicts=findConflicts([
  J('old','对方主体是示例学校','overturned','p1',[EV('file','文件名.txt','同音误判')]),
  J('now','对方主体是示例科技','current','p1',[EV('file','纪要.md#2','主体：示例科技')]),
 ]);
 assert(conflicts.length>=1,'推翻旧结论而新结论仍生效，应当被指出来');
 assert.match(conflicts[0].reason,/旧结论已被推翻/);
});

test('candidates are checked against stored judgments before they are drafted',()=>{
 const existing=[J('a','与示例伙伴的合作真实存在','current','p1',[EV('file','纪要.md#3','确认与示例伙伴有合作')])];
 const checked=checkCandidates(existing,[{title:'与示例伙伴的合作并不存在',evidence:[EV('message','msg-9','否认合作')],status:'current',projectId:'p1'}]);
 assert.equal(checked.conflicts.length,1,'候选与既有判断相反必须先报出来');
 assert.ok(['candidate-1'].includes(checked.conflicts[0].a.id) || ['candidate-1'].includes(checked.conflicts[0].b.id),'矛盾对里必须出现候选本身');
 assert.equal(checked.sameSubject[0].matches[0].id,'a');
 assert.equal(checkCandidates(existing,[]).conflicts.length,0,'没有候选就返回空，不硬凑');
});

test('judgment_checks is exposed as a read-only workstation action and rejects junk input',async()=>{
 const store=new WorkstationStore(':memory:');
 const ctx0={workspace:'trusted',actor:'agent',canWrite:true};
 const batch=store.draft(ctx0,{title:'seed',changes:[{op:'create',id:'a',kind:'judgment',data:{title:'与示例伙伴的合作真实存在',status:'current',validFrom:'2026-09-30',evidence:[EV('file','纪要.md#3','确认与示例伙伴有合作')]}}]});
 store.commit(ctx0,{batchId:batch.id,revision:1,key:'seed'});
 const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/trusted'}})},workspaceRegistry:{resolveByPath:async()=>({id:'trusted'})},approval:{request:async()=>'allowed-once'},allowedWorkspaces:['trusted']});
 const exec={agent:{id:'agent'},signal:new AbortController().signal};
 try{
  const tool=toolDefinition(adapter);
  assert.ok(tool.parameters.properties.action.enum.includes('judgment_checks'));
  assert.equal(tool.isConcurrencySafe({action:'judgment_checks'}),true);
  const result=await tool.execute({action:'judgment_checks',candidates:[{title:'与示例伙伴的合作并不存在',evidence:[EV('message','msg-9','否认合作')],status:'current'}]},exec);
  assert.equal(result.existing[0].id,'a');
  assert.equal(result.conflicts.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result,'工具输出必须无损 JSON');
  await assert.rejects(tool.execute({action:'judgment_checks',candidates:new Array(11).fill({title:'x'})},exec),{code:'INVALID'});
 }finally{store.close()}
});
