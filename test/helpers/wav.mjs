/** 测试用：构造宿主识别器要求的严格形态 WAV（16 kHz 单声道 PCM16）。
 *  识别器只接受这一种形态，所以任何走 transcribe 的测试都必须喂真实字节，
 *  否则测的是"转换失败"而不是"转写成功"。 */
export function canonicalWav({seconds=0.2,fill=false}={}){
 const samples=Math.round(16000*seconds)*2;
 const out=Buffer.alloc(44+samples);
 out.write('RIFF',0);out.writeUInt32LE(36+samples,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);
 out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
 out.write('data',36);out.writeUInt32LE(samples,40);
 if(fill)for(let index=44;index<out.length;index+=1)out[index]=index%251;
 return out;
}
