import {TEXT_FILE_MAX_BYTES,AUDIO_FILE_MAX_BYTES} from './limits.mjs';
import {DomainError} from './store.mjs';
function requireTextPath(path){if(typeof path==='string'&&/\.(?:docx?|xlsx?|pptx?|xlsm|docm|pptm|univer|pdf)$/i.test(path.trim()))throw new DomainError('INVALID','此文件格式需使用 Office 或专用查看器，不能通过文本编辑器读写');}
/** Host-owned grants, opaque provider targets and atomic guarded mutations. */
export class HostFiles {
 // grants 可以是数组，也可以是取函数：运行时授权（用户在界面里点授权）需要立刻生效，
 // 不能等到重启后再重建服务。
 constructor(fs,grants=[]){this.fs=fs;this.source=grants;this.grants=typeof grants==='function'?grants():grants;}
 refresh(){this.grants=typeof this.source==='function'?this.source():this.source;return this.grants;}
 async target(ctx,{grantId,path},write=false,allowRoot=false){const grant=this.grants.find(g=>g.id===grantId&&g.workspace===ctx.workspace);if(!grant?.read||(write&&!grant.write))throw new DomainError('FORBIDDEN','文件授权不足');if(typeof path!=='string'||!path.trim())throw new DomainError('INVALID','路径无效');const root=await this.fs.resolve(grant.root);const parent=await this.fs.resolve('..',{cwd:this.fs.processPath(root)});if(parent.targetKey===root.targetKey)throw new DomainError('FORBIDDEN','不能授权文件系统根目录');const target=await this.fs.resolve(path,{cwd:this.fs.processPath(root)});if(!this.fs.contains(root,target)||(!allowRoot&&root.targetKey===target.targetKey))throw new DomainError('FORBIDDEN','文件超出授权目录');return {root,target};}
 async list(ctx,args){const {offset=0,limit=100}=args;if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>250)throw new DomainError('INVALID','目录翻页参数无效');const {root,target}=await this.target(ctx,{...args,path:args.path??'.'},false,true);if((await this.fs.stat(target))?.type!=='directory')throw new DomainError('INVALID','需要目录');const entries=(await this.fs.listDir(target)).filter(e=>this.fs.contains(root,e.target)&&['file','directory'].includes(e.type));return {items:entries.slice(offset,offset+limit).map(e=>({name:e.name,type:e.type,size:e.size})),nextOffset:offset+limit<entries.length?offset+limit:null};}
 async read(ctx,args){requireTextPath(args.path);const {target}=await this.target(ctx,args);const before=await this.fs.stat(target);if(before?.type!=='file')throw new DomainError('INVALID','需要普通文本文件');const bytes=await this.fs.readBytes(target,undefined,TEXT_FILE_MAX_BYTES);const after=await this.fs.stat(target);if(after?.version!==before.version)throw new DomainError('CONFLICT','读取期间文件已修改');let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new DomainError('INVALID','需要 UTF-8 文本')}if(content.includes('\0'))throw new DomainError('INVALID','不支持二进制文件');return {content,version:after.version};}
 // 授权后的宿主绝对路径：交给宿主内其它服务（如知识库收录）读取，调用前已完成授权与目录边界检查。
 async hostPath(ctx,{grantId,path}){const {root,target}=await this.target(ctx,{grantId,path});const info=await this.fs.stat(target);if(info?.type!=='file')throw new DomainError('INVALID','需要普通文件');return {hostPath:this.fs.processPath(target),workspaceRoot:this.fs.processPath(root),version:info.version??null,size:Number.isFinite(info.size)?info.size:null};}
 // 只读版本：用于判断记录里的文件是否仍与当时一致（不读字节，不做任何写入）。
 async version(ctx,{grantId,path}){const {target}=await this.target(ctx,{grantId,path});const info=await this.fs.stat(target);if(!info)return {exists:false,type:null,size:null,version:null};return {exists:true,type:info.type??null,size:Number.isFinite(info.size)?info.size:null,version:info.version??null};}
 // 二进制读取：调用方声明允许的扩展名与用途，错误信息据此可操作（转写只收 WAV，预览只收图片/PDF）。
 async readBinary(ctx,{grantId,path,maxBytes=AUDIO_FILE_MAX_BYTES,extensions=['wav'],label='语音转写',limitMessage='音频文件超过转写大小限制'}){const list=(extensions??['wav']).map(item=>String(item).toLowerCase());const suffix=typeof path==='string'?path.trim().toLowerCase().split('.').pop():'';if(typeof path!=='string'||!list.includes(suffix))throw new DomainError('INVALID',label+'只接受授权目录内的 '+list.map(item=>'.'+item).join('、')+' 文件');const {target}=await this.target(ctx,{grantId,path});const before=await this.fs.stat(target);if(before?.type!=='file')throw new DomainError('INVALID','需要普通文件');// 超限用独立错误码，调用方才能与「格式不支持」区分开（HTTP 413 而不是 400）。
  if(Number.isFinite(before.size)&&before.size>maxBytes)throw new DomainError('TOO_LARGE',limitMessage);const bytes=await this.fs.readBytes(target,undefined,maxBytes);const after=await this.fs.stat(target);if(after?.version!==before.version)throw new DomainError('CONFLICT','读取期间文件已修改');return {bytes:Buffer.from(bytes),version:after.version,size:bytes.length};}
 // **按范围读**（2026-10-16 补，给录音播放用）：宪章判据 3 要"追回录音或文件的那一段"，
 // 而真实录音有 52MB —— 一次性读进来既不合适（内存/限额），浏览器也没法 seek。
 // 授权、目录边界、符号链接/硬链接这些检查与 readBinary 完全同一套（走 this.target），
 // 只是多带 start/end。返回 {bytes,size,version,eof}，调用方据此拼 206 响应。
 async readRange(ctx,{grantId,path,start=0,end=null,extensions=[],label='读取',maxBytes=Infinity,limitMessage='文件超过大小限制'}){
  const {target}=await this.target(ctx,{grantId,path});
  const info=await this.fs.stat(target);
  if(!info||info.type!=='file')throw new DomainError('INVALID','需要文件，不能对目录做这件事');
  if(Number.isFinite(info.size)&&info.size>maxBytes)throw new DomainError('TOO_LARGE',limitMessage);
  const list=(extensions??[]).map(item=>String(item).toLowerCase());
  const suffix=String(path).trim().toLowerCase().split('.').pop();
  if(list.length&&!list.includes(suffix))throw new DomainError('INVALID',label+'不支持 .'+suffix+' 这种格式');
  const from=Math.max(0,Number.isFinite(start)?Math.floor(start):0);
  const to=end===null||!Number.isFinite(end)?Math.max(0,(info.size??0)-1):Math.min(Math.floor(end),Math.max(0,(info.size??0)-1));
  if(to<from)throw new DomainError('INVALID','读取范围无效');
  // **必须用 readByteRange**（宿主 fs 服务真实提供的方法）。
  // 我第一版写的是 `readBytes(target, from, length)` —— 那是错的：宿主签名是
  // `readBytes(target, signal, maxBytes)`，第二个参数是 signal 不是偏移量。
  // 是靠 Cordis Inspect 查宿主真实契约才发现的（桩里没有这个方法，光跑门禁永远发现不了）。
  const bytes=await this.fs.readByteRange(target,{offset:from,length:to-from+1});
  return {bytes,size:info.size??bytes.length,version:info.version??null,start:from,end:to,eof:to>=(info.size??bytes.length)-1};
 }
 async save(ctx,args){requireTextPath(args.path);if(typeof args.version!=='string'||!args.version||typeof args.content!=='string'||Buffer.byteLength(args.content)>TEXT_FILE_MAX_BYTES||args.content.includes('\0'))throw new DomainError('INVALID','内容或版本无效');const {root,target}=await this.target(ctx,args,true);return this.fs.writeText(target,args.content,{kind:'replaceIfVersion',version:args.version},undefined,{mode:'workspace-write',workspaceRoot:this.fs.processPath(root)});}
}
