import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkstationStore} from '../src/store.mjs';
const ctx={workspace:'w',actor:'test',canWrite:true};
function commit(s,changes,key){const b=s.draft(ctx,{title:key,changes});return s.commit(ctx,{batchId:b.id,revision:b.revision,key});}
test('disk reopen retains objects, receipt and inbox',()=>{const path=join(mkdtempSync(join(tmpdir(),'workstation-test-')),'data.sqlite');let s=new WorkstationStore(path);const r=commit(s,[{op:'create',id:'p',kind:'project',data:{title:'真实长期保存'}}],'create');s.close();s=new WorkstationStore(path);try{assert.equal(s.get(ctx,'p').data.title,'真实长期保存');assert.equal(s.receipt(ctx,'create').id,r.id);assert.equal(s.inbox(ctx,{status:'committed'}).length,1);}finally{s.close()}});
test('archive cannot leave live references; batch undo restores archived objects',()=>{const s=new WorkstationStore(':memory:');try{commit(s,[{op:'create',id:'p',kind:'project',data:{title:'项目'}},{op:'create',id:'t',kind:'task',data:{title:'任务',projectId:'p'}}],'initial');assert.throws(()=>commit(s,[{op:'archive',id:'p',expectedRevision:1}],'bad'),{code:'REFERENCE'});commit(s,[{op:'archive',id:'p',expectedRevision:1},{op:'archive',id:'t',expectedRevision:1}],'archive');const undo=s.undoDraft(ctx,'archive');s.commit(ctx,{batchId:undo.id,revision:undo.revision,key:'restore'});assert.equal(s.get(ctx,'p').archived,false);assert.equal(s.get(ctx,'t').revision,3);assert.throws(()=>s.undoDraft(ctx,'initial'),{code:'CONFLICT'});}finally{s.close()}});
test('undo creation archives all related objects atomically',()=>{const s=new WorkstationStore(':memory:');try{commit(s,[{op:'create',id:'p',kind:'project',data:{title:'项目'}}],'create');const u=s.undoDraft(ctx,'create');assert.equal(s.preview(ctx,u.id).diff[0].op,'archive');s.commit(ctx,{batchId:u.id,revision:1,key:'undo'});assert.equal(s.list(ctx).length,0);assert.equal(s.list(ctx,{includeArchived:true}).length,1);}finally{s.close()}});
