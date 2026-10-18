import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkstationStore} from '../src/store.mjs';
const ctx={workspace:'test',actor:'test',canWrite:true};
test('invalid field, execution forgery, unzoned date and malformed progress rejected',()=>{const s=new WorkstationStore(':memory:');try{for(const data of [{title:'x',execution:{status:'success'}},{title:'x',admin:true},{title:'x',dueDate:'2026-10-10T12:00:00'},{title:'x',steps:[{id:'a',title:'x',done:'yes'}]}]){const b=s.draft(ctx,{title:'invalid',changes:[{op:'create',kind:'task',data}]});assert.throws(()=>s.commit(ctx,{batchId:b.id,revision:1,key:b.id}),{code:'INVALID'});}assert.equal(s.list(ctx).length,0);}finally{s.close()}});
test('two database connections reject stale draft revisions and leave latest intact',()=>{const path=join(mkdtempSync(join(tmpdir(),'workstation-cas-')),'db');const a=new WorkstationStore(path),b=new WorkstationStore(path);try{const input={title:'v1',changes:[{op:'create',kind:'project',data:{title:'项目'}}]};const first=a.draft(ctx,input);const second=b.draft(ctx,{...input,title:'v2'},first.id,1);assert.equal(second.revision,2);assert.throws(()=>a.draft(ctx,{...input,title:'lost'},first.id,1),{code:'CONFLICT'});assert.equal(a.batch(ctx,first.id).title,'v2');assert.throws(()=>a.draft(ctx,input,'missing',1),{code:'CONFLICT'});}finally{a.close();b.close()}});
