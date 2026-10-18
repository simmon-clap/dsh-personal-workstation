import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DomainError} from './store.mjs';

/** 语音输入规范化：宿主识别器只接受**严格规范**的 16 kHz 单声道 PCM16 WAV
 *  （RIFF/WAVE、fmt 块恰好 16 字节、data 紧跟在 36 字节处、长度字段自洽），
 *  实测 ffmpeg/afconvert 常见的附加块（如 Apple 的 FLLR）都会被拒。
 *  手机录音基本是 m4a/opus，因此这里做两件事：
 *    1) 已经是规范 WAV 就原样通过；
 *    2) 其他格式先调用本机转换工具，再规范化为严格形态。
 *  转换工具只用系统自带（macOS afconvert）或常见的 ffmpeg，参数以数组传递、不经过 shell。 */

const TARGET_SAMPLE_RATE=16000,BYTES_PER_SECOND=32000;

/** 判断是否已经是宿主要求的严格形态。 */
export function isCanonicalWav(bytes){
 if(bytes.length<46)return false;
 if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.toString('ascii',12,16)!=='fmt ')return false;
 const view=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 return view.readUInt32LE(16)===16&&view.readUInt16LE(20)===1&&view.readUInt16LE(22)===1
  &&view.readUInt32LE(24)===TARGET_SAMPLE_RATE&&view.readUInt32LE(28)===BYTES_PER_SECOND
  &&view.readUInt16LE(32)===2&&view.readUInt16LE(34)===16&&view.toString('ascii',36,40)==='data'
  &&view.readUInt32LE(4)===view.length-8&&view.readUInt32LE(40)===view.length-44&&(view.length-44)%2===0;
}

/** 读取 WAV 的 fmt 信息；不是 WAV 或字段缺失时返回 null。 */
export function readWavFormat(bytes){
 const view=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.length<44||view.toString('ascii',0,4)!=='RIFF'||view.toString('ascii',8,12)!=='WAVE')return null;
 let offset=12,format=null,data=null;
 while(offset+8<=view.length){
  const id=view.toString('ascii',offset,offset+4),size=view.readUInt32LE(offset+4);
  if(id==='fmt '&&size>=16)format={tag:view.readUInt16LE(offset+8),channels:view.readUInt16LE(offset+10),rate:view.readUInt32LE(offset+12),bits:view.readUInt16LE(offset+22),raw:view.subarray(offset+8,offset+8+Math.min(size,40))};
  if(id==='data'){data=view.subarray(offset+8,Math.min(offset+8+size,view.length));break}
  offset+=8+size+(size%2);
 }
 if(!format||!data)return null;
 // WAVE_FORMAT_EXTENSIBLE（0xFFFE）的 fmt 末尾是子格式 GUID，其前两字节才是真正的编码。
 const tag=format.tag===0xFFFE&&format.raw.length>=26?format.raw.readUInt16LE(24):format.tag;
 return {...format,tag,data};
}

/** 把 WAV 剥成宿主要求的严格形态。**只有在采样率/声道/位深本来就符合时**才重建头部——
 *  否则等于伪造头部：把 44.1kHz 立体声标成 16kHz 单声道会毁掉音频。不符合时返回 null，
 *  交给转换工具去做真正的重采样。 */
export function canonicalizeWav(bytes){
 const info=readWavFormat(bytes);
 if(!info)return null;
 if(info.tag!==1||info.channels!==1||info.rate!==TARGET_SAMPLE_RATE||info.bits!==16)return null;
 let samples=Buffer.from(info.data);
 if(samples.length%2)samples=samples.subarray(0,samples.length-1);
 const out=Buffer.alloc(44+samples.length);
 out.write('RIFF',0);out.writeUInt32LE(36+samples.length,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);
 out.writeUInt32LE(TARGET_SAMPLE_RATE,24);out.writeUInt32LE(BYTES_PER_SECOND,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
 out.write('data',36);out.writeUInt32LE(samples.length,40);samples.copy(out,44);
 return out;
}

const CONVERTERS=[
 {name:'afconvert',args:(input,output)=>['-f','WAVE','-d','LEI16@16000','-c','1',input,output]},
 {name:'ffmpeg',args:(input,output)=>['-hide_banner','-loglevel','error','-y','-i',input,'-ac','1','-ar','16000','-c:a','pcm_s16le',output]}
];

function runFile(command,args){
 return new Promise(resolve=>{
  execFile(command,args,{timeout:60000,maxBuffer:1024*1024},error=>resolve(!error));
 });
}

export function createAudioInput({run=runFile}={}){
 return {
  /** 返回严格形态的 WAV 字节；无法转换时抛出可直接展示的原因。 */
  async normalize(bytes,extension){
   const source=Buffer.from(bytes.buffer??bytes,bytes.byteOffset??0,bytes.byteLength??bytes.length);
   if(isCanonicalWav(source))return {bytes:source,converted:false};
   const stripped=canonicalizeWav(source);
   if(stripped&&isCanonicalWav(stripped))return {bytes:stripped,converted:false,note:'已剔除 WAV 附加块'};
   const suffix=String(extension??'').toLowerCase().replace(/[^a-z0-9]/g,'');
   if(!suffix)throw new DomainError('INVALID','无法确定音频格式：请提供 .wav、.m4a、.mp3 等扩展名的文件路径');
   const directory=await mkdtemp(join(tmpdir(),'workstation-audio-'));
   const input=join(directory,'input.'+suffix),output=join(directory,'output.wav');
   try{
    await mkdir(directory,{recursive:true});
    await writeFile(input,source);
    let used=null;
    for(const converter of CONVERTERS){
     const ok=await run(converter.name,converter.args(input,output));
     if(ok){used=converter.name;break}
    }
    if(!used)throw new DomainError('UNAVAILABLE','本机没有可用的音频转换工具（afconvert 或 ffmpeg）。语音识别只接受 16 kHz 单声道 PCM16 WAV，请先自行转换后再试。');
    const converted=await readFile(output).catch(()=>null);
    if(!converted)throw new DomainError('UNAVAILABLE',used+' 转换失败：没有得到输出文件');
    const final=canonicalizeWav(converted);
    if(!final||!isCanonicalWav(final))throw new DomainError('UNAVAILABLE',used+' 的输出不是 16 kHz 单声道 PCM16 WAV，无法用于识别');
    return {bytes:final,converted:true,converter:used};
   }finally{
    await rm(directory,{recursive:true,force:true}).catch(()=>{});
   }
  }
 };
}
