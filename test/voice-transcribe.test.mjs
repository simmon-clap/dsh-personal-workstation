import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkstationStore} from '../src/store.mjs';
import {DshAdapter} from '../src/dsh-adapter.mjs';
import {canonicalWav} from './helpers/wav.mjs';

// G2 语音入口的插件侧契约：授权目录内的 WAV → DSH speechToText → 文本 → 由模型生成项目/任务。
// 这里用假的 speechToText 服务验证接线与授权，不声称已跑过真实模型。
const CWD='/w';
function setup({speech=true,audio=undefined,grant={id:'g1',workspace:'w',root:'/audio',read:true,write:false},approval='allowed-once',bytes=canonicalWav({seconds:0.4})}={}){
 const store=new WorkstationStore(':memory:');
 const written=[];
 const files=grant?{
  async readBinary(ctx,{grantId,path,maxBytes=25*1024*1024}){
   // 与 HostFiles 一致：先校验格式，再校验授权与目录边界。
   if(!/\.wav$/i.test(path))throw Object.assign(new Error('语音转写只接受授权目录内的 .wav 文件；其他格式需先转为 WAV'),{code:'INVALID'});
   if(grantId!==grant.id||ctx.workspace!==grant.workspace||path.includes('..'))throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});
   if(bytes.length>maxBytes)throw Object.assign(new Error('音频文件超过转写最多'),{code:'INVALID'});
   written.push({grantId,path});return {bytes,version:'v1',size:bytes.length};
  }
 }:undefined;
 const speechClient=speech?{
  resolve(request){if(!request.audio)throw new Error('缺少音频');return {provider:{info:{id:'sensevoice'}},audio:request.audio,language:request.language??'auto'}},
  async transcribe(spec,signal){
   if(signal?.aborted)throw new Error('aborted');
   if(!Buffer.isBuffer(spec.audio))throw new Error('音频必须是 Buffer');
   if(spec.audio.length<88)throw new Error('Speech worker rejected input');
   return {text:'会议纪要：确认试点范围；下一步整理资料。',audioSeconds:12.5,inferenceSeconds:1.4};
  }
 }:undefined;
 const adapter=new DshAdapter({store,files,knowledge:undefined,executions:undefined,runner:undefined,speech:speechClient,audio,executionConfig:{enabled:false},sessions:{get:id=>id==='s'?{header:{cwd:CWD}}:null},workspaceRegistry:{resolveByPath:async path=>path===CWD?{id:'w'}:null,get:()=>({id:'w'})},allowedWorkspaces:['w'],approval:{request:async()=>approval}});
 return {store,adapter,written,call:(action,args={})=>adapter.run({action,...args},{agent:{id:'s'},callId:'c1'})};
}
test('a granted meeting recording is transcribed through the host speech service',async()=>{
 const {store,call,written}=setup();
 try{
  const result=await call('transcribe',{grantId:'g1',path:'meetings/2026-10-12.wav',language:'zh'});
  assert.match(result.text,/确认试点范围/,'必须返回真实转写文本');
  assert.equal(result.provider,'sensevoice');assert.equal(result.language,'zh');
  assert.equal(result.audioSeconds,12.5);assert.equal(result.inferenceSeconds,1.4);
  assert.deepEqual(written,[{grantId:'g1',path:'meetings/2026-10-12.wav'}]);
  assert.equal((await call('inbox',{})).items.length,0,'转写本身不写业务数据，必须由模型再用 draft 生成项目/任务');
 }finally{store.close()}
});
test('transcription reports plainly when the host has no speech service',async()=>{
 const {store,call}=setup({speech:false});
 try{
  const error=await call('transcribe',{grantId:'g1',path:'a.wav'}).then(()=>null,reason=>reason);
  assert(error);assert.match(error.message,/语音转写未接入/,'未接入必须如实说明而不是假装成功');
  assert.match(error.message,/speechToText/);
 }finally{store.close()}
});
test('transcription needs approval and never reads the file when it is refused',async()=>{
 const {store,call,written}=setup({approval:'rejected'});
 try{
  const error=await call('transcribe',{grantId:'g1',path:'a.wav'}).then(()=>null,reason=>reason);
  assert.match(error.message,/未获许可/);
  assert.deepEqual(written,[],'审批被拒时不得读取音频');
 }finally{store.close()}
});
test('unauthorized grants, non-WAV and escaping paths are refused with reasons',async()=>{
 const unauthorized=setup({grant:{id:'g9',workspace:'w',root:'/audio',read:false}});
 try{await assert.rejects(unauthorized.call('transcribe',{grantId:'g1',path:'a.wav'}),/文件授权不足/)}finally{unauthorized.store.close()}
 const granted=setup();
 try{
  await assert.rejects(granted.call('transcribe',{grantId:'g1',path:'a.mp3'}),/只接受授权目录内的 \.wav/,'非 WAV 必须说明需要先转码');
  await assert.rejects(granted.call('transcribe',{grantId:'g1',path:'../escape.wav'}),/文件授权不足|超出授权目录/);
 }finally{granted.store.close()}
});
test('a provider failure surfaces as an error, not as an empty transcript',async()=>{
 // 识别器拒绝时必须是错误，而不是空转写。用一段"短到不可能是真实录音"的规范 WAV 触发。
 const {store,call}=setup({bytes:canonicalWav({seconds:0.001})});
 try{
  await assert.rejects(call('transcribe',{grantId:'g1',path:'a.wav'}),/Speech worker rejected input/);
 }finally{store.close()}
});

test('the user can choose whether Agent transcription needs approval, and the boundary stays the grant',async()=>{
 const {DshAdapter}=await import('../src/dsh-adapter.mjs');
 const {WorkstationStore}=await import('../src/store.mjs');
 const make=(transcribeWithoutApproval)=>{
  const store=new WorkstationStore(':memory:');
  const adapter=new DshAdapter({store,sessions:{get:()=>({header:{cwd:'/w'}}),readTitle:async()=>null},workspaceRegistry:{resolveByPath:async()=>({id:'w'}),get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],
   approval:{request:async()=>{approvals+=1;return 'rejected'}},
   files:{grants:[{id:'voice-inbox',workspace:'w',root:'/voice',read:true,write:false}],readBinary:async(ctx,{path})=>{reads.push(path);return {bytes:canonicalWav({seconds:0.2}),size:canonicalWav({seconds:0.2}).length}}},
   speech:{resolve:request=>({...request,provider:{info:{id:'p'}},language:'auto'}),transcribe:async()=>({text:'文字',audioSeconds:1,inferenceSeconds:1})},
   transcribeWithoutApproval});
  return {store,adapter};
 };
 let approvals=0,reads=[];
 const off=make(false);
 try{
  await assert.rejects(()=>off.adapter.run({action:'transcribe',grantId:'voice-inbox',path:'inbox/a.wav'},{agent:{id:'s1'},callId:'c1',workspace:'w'}),/语音转写未获许可/);
  assert.equal(approvals,1,'默认必须真的发起一次审批');
  assert.equal(reads.length,0,'未获许可前不得读取音频');
 }finally{off.store.close()}
 approvals=0;reads=[];
 const on=make(true);
 try{
  const result=await on.adapter.run({action:'transcribe',grantId:'voice-inbox',path:'inbox/a.wav'},{agent:{id:'s1'},callId:'c1',workspace:'w'});
  assert.equal(result.text,'文字');
  assert.equal(approvals,0,'用户显式关闭后不应再发起审批');
  assert.deepEqual(reads,['inbox/a.wav'],'读取仍必须走授权目录');
 }finally{on.store.close()}
});
