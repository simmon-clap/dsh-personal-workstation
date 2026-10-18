import {test} from 'node:test';import assert from 'node:assert/strict';import {HostFiles} from '../src/host-files.mjs';
test('resolved root alias is denied before content access',async()=>{let read=false;const fs={resolve:async()=>({targetKey:'filesystem-root'}),processPath:()=> '/',readBytes:async()=>{read=true}};const files=new HostFiles(fs,[{id:'g',workspace:'w',root:'/alias',read:true,write:true}]);await assert.rejects(files.read({workspace:'w'},{grantId:'g',path:'secret'}),{code:'FORBIDDEN'});assert.equal(read,false)});
test('read races reject and stale writes propagate without unconditional retry',async()=>{let statCalls=0,writes=0;const fs={resolve:async p=>({targetKey:p}),processPath:()=>'/grant',contains:()=>true,stat:async()=>({type:'file',version:++statCalls===1?'old':'new'}),readBytes:async()=>Buffer.from('content'),writeText:async()=>{writes++;throw Object.assign(new Error('stale'),{code:'FS_STALE_VERSION'})}};const f=new HostFiles(fs,[{id:'g',workspace:'w',root:'/grant',read:true,write:true}]),ctx={workspace:'w'},args={grantId:'g',path:'note.md'};await assert.rejects(f.read(ctx,args),{code:'CONFLICT'});await assert.rejects(f.save(ctx,{...args,version:'old',content:'new'}),{code:'FS_STALE_VERSION'});assert.equal(writes,1)});
test('host adapter uses opaque targets and guarded atomic write with grant root',async()=>{let write;const root={targetKey:'opaque-root'},file={targetKey:'opaque-file'};const fs={resolve:async p=>p==='/grant'?root:file,contains:(a,b)=>a===root&&b===file,processPath:()=>'/grant',stat:async()=>({type:'file',version:'v1'}),readBytes:async()=>Buffer.from('text'),writeText:async(...args)=>{write=args;return {version:'v2'}}};const files=new HostFiles(fs,[{id:'g',workspace:'w',root:'/grant',read:true,write:true}]);const ctx={workspace:'w'},args={grantId:'g',path:'note.md'};assert.equal((await files.read(ctx,args)).content,'text');await files.save(ctx,{...args,version:'v1',content:'new'});assert.equal(write[0],file);assert.deepEqual(write[2],{kind:'replaceIfVersion',version:'v1'});assert.deepEqual(write[4],{mode:'workspace-write',workspaceRoot:'/grant'});fs.contains=()=>false;await assert.rejects(files.save(ctx,{...args,version:'v1',content:'no'}),{code:'FORBIDDEN'});await assert.rejects(files.read({workspace:'other'},args),{code:'FORBIDDEN'})});
test('binary audio read enforces format, grant boundary, size limit and version race',async()=>{
 const root={targetKey:'root'},inside={targetKey:'inside'};let bytes=Buffer.from('RIFF');
 const fs={resolve:async p=>({targetKey:p}),processPath:()=>'/grant',contains:(r,t)=>t.targetKey!=='outside',stat:async t=>({type:'file',size:bytes.length,version:'v1'}),readBytes:async()=>bytes};
 const files=new HostFiles(fs,[{id:'g',workspace:'w',root:'/grant',read:true}]),ctx={workspace:'w'};
 assert.equal((await files.readBinary(ctx,{grantId:'g',path:'meeting.wav'})).size,4,'应返回原始字节而不是解码文本');
 for(const path of ['a.mp3','a.ogg','a.m4a','a.wav.bak'])await assert.rejects(files.readBinary(ctx,{grantId:'g',path}),{code:'INVALID'});
 await assert.rejects(files.readBinary({workspace:'other'},{grantId:'g',path:'a.wav'}),{code:'FORBIDDEN'});
 await assert.rejects(files.readBinary(ctx,{grantId:'missing',path:'a.wav'}),{code:'FORBIDDEN'});
 bytes=Buffer.alloc(64);
 await assert.rejects(files.readBinary(ctx,{grantId:'g',path:'a.wav',maxBytes:32}),/超过转写大小限制/,'超限必须拒绝而不是截断');
 let statCalls=0;fs.stat=async()=>({type:'file',size:4,version:++statCalls%2?'v1':'v2'});
 await assert.rejects(files.readBinary(ctx,{grantId:'g',path:'a.wav'}),{code:'CONFLICT'},'读取期间被改写必须报冲突');
 fs.contains=()=>false;void root;void inside;
 await assert.rejects(files.readBinary(ctx,{grantId:'g',path:'a.wav'}),{code:'FORBIDDEN'});
});
