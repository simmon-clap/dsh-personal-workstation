// 最小 fs 端口实现（对齐 DSH 宿主 fs 的契约：resolve 返回带 targetKey 的对象）。
import {statSync,readFileSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
const abs=value=>resolve(typeof value==='string'?value:(value?.path??value?.targetKey??'.'));
const real=value=>{const p=abs(value);return realpathSync(p)};
export function createFsPort(){
 return {
  processPath(value){return abs(value)},
  resolve(target,options){const base=options?.cwd??process.cwd();const p=resolve(base,String(typeof target==='string'?target:(target?.path??'.')));return {path:p,targetKey:realpathSync(p)}},
  contains(parent,child){const a=real(parent),b=real(child);return b===a||b.startsWith(a+sep)},
  stat(value){try{const s=statSync(real(value));return {type:s.isDirectory()?'directory':'file',size:s.size,mtimeMs:s.mtimeMs}}catch{return null}},
  readBytes(value){return readFileSync(real(value))},
  // 宿主 fs 服务真实提供 readByteRange(target,{offset,length})；桩里没有它 =
  // 任何"按范围读"的代码在门禁里都跑不到 —— 桩比宿主弱，门禁就比现实弱。
  readByteRange(value,{offset=0,length=Infinity}={}){
   const bytes=readFileSync(real(value));
   return bytes.subarray(offset,Number.isFinite(length)?offset+length:undefined);
  },
  writeText(value,text){writeFileSync(real(value),text,'utf8')},
  listDir(value){return readdirSync(real(value),{withFileTypes:true}).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':'file'}))},
 };
}
