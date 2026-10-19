import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DomainError} from './store.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>{throw new DomainError(code,message)};
/** Grants are explicit, host-owned records. No default filesystem access. */
export class FileService {
 constructor({grants=[],maxBytes=2*1024*1024}){this.grants=grants.map(g=>Object.freeze({...g}));this.maxBytes=maxBytes;this.locks=new Map();}
 async target(ctx,grantId,path,write=false){
  const g=this.grants.find(g=>g.id===grantId&&g.workspace===ctx.workspace);
  if(!g||!g.read||(write&&!g.write))fail('FORBIDDEN','目录未授权此操作');
  if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\0'))fail('INVALID','需要授权目录内的相对路径');
  const root=await realpath(g.root),full=resolve(root,path),rel=relative(root,full);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('FORBIDDEN','路径超出授权目录');
  let cursor=root;for(const part of rel.split(sep)){cursor=resolve(cursor,part);if((await lstat(cursor)).isSymbolicLink())fail('FORBIDDEN','不允许通过符号链接访问');}
  const canonical=await realpath(full);if(canonical!==full)fail('FORBIDDEN','路径在检查期间变化');
  return {g,root,full};
 }
 listGrants(ctx){return this.grants.filter(g=>g.workspace===ctx.workspace).map(({id,label,read,write})=>({id,label,read:!!read,write:!!write}));}
 async snapshot(handle){const stat=await handle.stat();if(!stat.isFile()||stat.size>this.maxBytes)fail('INVALID','仅支持大小受限的普通文本文件');const bytes=await handle.readFile();if(bytes.length>this.maxBytes)fail('INVALID','文件过大');let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{fail('INVALID','需要 UTF-8 文本')};if(content.includes('\0'))fail('INVALID','不支持二进制内容');return {content,version:hash(bytes),size:bytes.length,stat};}
 async read(ctx,{grantId,path}){const t=await this.target(ctx,grantId,path);const f=await open(t.full,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await this.snapshot(f);return {grantId,path,content:s.content,version:s.version,size:s.size}}finally{await f.close()}}
 async save(ctx,{grantId,path,version,content}){
  if(typeof content!=='string'||Buffer.byteLength(content)>this.maxBytes||content.includes('\0')||typeof version!=='string')fail('INVALID','文本或版本无效');
  const t=await this.target(ctx,grantId,path,true);const key=t.full;
  const previous=this.locks.get(key)??Promise.resolve();let release;const turn=new Promise(r=>release=r);this.locks.set(key,turn);await previous;
  try{
   // Re-resolve after waiting; reject removed or changed grants/paths.
   await this.target(ctx,grantId,path,true);
   const f=await open(t.full,constants.O_RDWR|constants.O_NOFOLLOW);
   try{const old=await this.snapshot(f);if(old.stat.nlink!==1)fail('FORBIDDEN','不允许修改硬链接文件');if(old.version!==version)fail('CONFLICT','文件已修改，请重新读取并合并');
    const pathStat=await lstat(t.full);if(pathStat.ino!==old.stat.ino||pathStat.dev!==old.stat.dev)fail('CONFLICT','文件已替换');
    const bytes=Buffer.from(content);let offset=0;while(offset<bytes.length){const {bytesWritten}=await f.write(bytes,offset,bytes.length-offset,offset);if(!bytesWritten)fail('IO','文件写入未推进');offset+=bytesWritten;}await f.truncate(bytes.length);await f.sync();return {grantId,path,version:hash(bytes),size:bytes.length,status:'saved'};
   }finally{await f.close()}
  }finally{release();if(this.locks.get(key)===turn)this.locks.delete(key)}
 }
}
