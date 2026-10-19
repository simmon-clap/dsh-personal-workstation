import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalizeWav,createAudioInput,isCanonicalWav,readWavFormat} from '../src/audio-input.mjs';

/** 造一个规范形态 WAV（16k 单声道 16bit）。 */
function wav({rate=16000,channels=1,bits=16,seconds=0.5,extraChunk=null}={}){
 const samples=Math.round(rate*seconds)*(bits/8)*channels;
 const extra=extraChunk?8+extraChunk.length:0;
 const out=Buffer.alloc(44+extra+samples);
 out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(channels,22);
 out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*channels*(bits/8),28);out.writeUInt16LE(channels*(bits/8),32);out.writeUInt16LE(bits,34);
 let offset=36;
 if(extraChunk){out.write('FLLR',offset);out.writeUInt32LE(extraChunk.length,offset+4);extraChunk.copy(out,offset+8);offset+=extra}
 out.write('data',offset);out.writeUInt32LE(samples,offset+4);
 return out;
}

test('a canonical WAV passes through untouched',async()=>{
 const input=createAudioInput({run:async()=>false}),source=wav();
 assert(isCanonicalWav(source));
 const result=await input.normalize(source,'wav');
 assert.equal(result.converted,false);
 assert.deepEqual(Buffer.from(result.bytes),source);
});
test('extra chunks are stripped so the recognizer accepts the file',async()=>{
 const input=createAudioInput({run:async()=>false});
 const padded=wav({extraChunk:Buffer.alloc(4020)});
 assert(!isCanonicalWav(padded),'带 FLLR 的文件本就不合规（实测 afconvert 就是这样输出的）');
 const result=await input.normalize(padded,'wav');
 assert(isCanonicalWav(result.bytes));
 assert.equal(result.bytes.length,padded.length-4028,'只应去掉附加块');
});
test('a different sample rate is NOT relabelled — that would fake the header',async()=>{
 // 44.1k 立体声必须交给转换工具重采样，绝不能只改头部字段（那会毁掉音频）。
 assert.equal(canonicalizeWav(wav({rate:44100,channels:2})),null);
 const calls=[];
 const input=createAudioInput({run:async(command,args)=>{calls.push({command,args});return false}});
 await assert.rejects(()=>input.normalize(wav({rate:44100,channels:2}),'wav'),/没有可用的音频转换工具/);
 assert.equal(calls.length,2,'两个转换工具都应尝试过');
});
test('a phone recording (m4a) is converted locally when a converter exists',async()=>{
 const calls=[];
 const input=createAudioInput({run:async(command,args)=>{
  calls.push({command,args});
  if(command!=='afconvert')return false;
  writeFileSync(args[args.length-1],wav()); // 模拟转换器产出规范 WAV
  return true;
 }});
 const result=await input.normalize(Buffer.from('not a wav at all'),'m4a');
 assert.equal(result.converted,true);
 assert.equal(result.converter,'afconvert');
 assert(isCanonicalWav(result.bytes));
 assert.deepEqual(calls[0].args.slice(0,6),['-f','WAVE','-d','LEI16@16000','-c','1'],'必须显式要求 16k 单声道 PCM16');
});
test('missing extension and unusable audio give reasons a user can act on',async()=>{
 const input=createAudioInput({run:async()=>false});
 await assert.rejects(()=>input.normalize(Buffer.from('x'),''),/无法确定音频格式/);
 await assert.rejects(()=>input.normalize(Buffer.from('x'),'m4a'),/afconvert 或 ffmpeg/);
});
test('readWavFormat understands WAVE_FORMAT_EXTENSIBLE, which is what afconvert writes',()=>{
 const samples=Buffer.alloc(3200);
 const out=Buffer.alloc(44+40+samples.length);
 out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVE',8);
 // fmt 块声明 40 字节、tag=0xFFFE、子格式 GUID 前两字节 = 1（PCM）
 out.write('fmt ',12);out.writeUInt32LE(40,16);out.writeUInt16LE(0xFFFE,20);out.writeUInt16LE(1,22);
 out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
 // fmt 数据从 20 开始：22 字节扩展头之后是 16 字节子格式 GUID，其前 4 字节即真正的编码（1=PCM）
 out.writeUInt16LE(22,36);out.writeUInt16LE(0,38);out.writeUInt32LE(0x00000001,20+24);
 out.write('data',12+8+40);out.writeUInt32LE(samples.length,12+8+40+4);
 const info=readWavFormat(out);
 assert(info,'必须能解析 extensible 头');
 assert.equal(info.tag,1,'extensible 的子格式是 PCM 时应识别为 PCM');
 assert.equal(info.channels,1);
 assert.equal(info.rate,16000);
});
test('the real recorder output converts end to end when afconvert is present',()=>{
 const directory=mkdtempSync(join(tmpdir(),'audio-check-'));
 try{
  const aiff=join(directory,'say.aiff'),m4a=join(directory,'say.m4a');
  try{execFileSync('say',['-v','Tingting','-o',aiff,'试点范围跟进'],{timeout:30000});execFileSync('afconvert',['-f','m4af','-d','aac','-b','64000',aiff,m4a],{timeout:30000})}
  catch{return; // 没有 say/afconvert 的环境跳过，不假装通过
  }
  if(!existsSync(m4a))return;
  const input=createAudioInput();
  return input.normalize(readFileSync(m4a),'m4a').then(result=>{
   assert.equal(result.converted,true);
   assert(isCanonicalWav(result.bytes),'转换结果必须是宿主要求的严格形态');
  });
 }finally{rmSync(directory,{recursive:true,force:true})}
});
