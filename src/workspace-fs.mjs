import {mkdirSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,join,resolve,sep} from 'node:path';
import {DomainError} from './store.mjs';

/** 工作区内的目录操作：让用户能在「空间与设置」里**看到工作区里有哪些文件夹、并新建文件夹**，
 *  不必先去命令行或 Finder 里准备。
 *  边界（来自《个人工作台整体规划》对本地文件工具的要求）：
 *   · 只允许在工作区目录之内；
 *   · 逐段拒绝 `..`、绝对路径与空白段；
 *   · 用真实路径（realpath）再判一次，符号链接不能成为越界的跳板。 */

const GRANT_FREE_LIST_LIMIT=200;

function safeSegments(relative){
 if(relative===undefined||relative===null||relative==='')return [];
 if(typeof relative!=='string')throw new DomainError('INVALID','路径必须是字符串');
 // 绝对路径不静默当相对路径用：那会让用户以为自己在操作别的目录。
 if(relative.startsWith('/')||/^[A-Za-z]:[\\/]/.test(relative))throw new DomainError('INVALID','请使用工作区内的相对路径（例如 资料/会议），不要用绝对路径');
 const parts=relative.split('/').filter(part=>part!==''&&part!=='.');
 for(const part of parts){
  if(part==='..')throw new DomainError('FORBIDDEN','路径不能包含 ..（不允许跳出工作区）');
  if(part.includes('\0'))throw new DomainError('INVALID','路径包含非法字符');
  if(sep!=='/'&&part.includes(sep))throw new DomainError('INVALID','路径包含非法分隔符');
 }
 return parts;
}

function insideRoot(root,target){
 const normalizedRoot=root.endsWith(sep)?root:root+sep;
 return target===root||target.startsWith(normalizedRoot);
}

export function createWorkspaceFs(){
 function rootOf(workspacePath){
  if(typeof workspacePath!=='string'||!workspacePath.trim())throw new DomainError('UNAVAILABLE','拿不到当前工作区目录');
  return resolve(workspacePath);
 }
 /** 解析到工作区内的真实路径；越界或不存在时给出可执行的原因。 */
 function resolveInside(workspacePath,relative,{mustExist=true}={}){
  const root=rootOf(workspacePath);
  const target=resolve(root,...safeSegments(relative));
  if(!insideRoot(root,target))throw new DomainError('FORBIDDEN','只能访问已授权的路径');
  let real=null;
  try{real=realpathSync(target)}catch{ if(mustExist)throw new DomainError('NOT_FOUND','目录不存在：'+(relative||'.')) }
  if(real!==null&&!insideRoot(realpathSync(root),real))throw new DomainError('FORBIDDEN','该路径通过符号链接指向工作区之外，已拒绝');
  return {root,target,real};
 }
 return {
  resolveInside,
  /** 列出工作区里某个目录下的子目录（只给名字与相对路径，不读内容）。 */
  list(workspacePath,relative=''){
   const {root,real}=resolveInside(workspacePath,relative,{mustExist:true});
   let entries=[];
   try{entries=readdirSync(real??join(root,...safeSegments(relative)),{withFileTypes:true})}catch(error){throw new DomainError('INVALID','无法读取该目录：'+error.message)}
   const directories=entries.filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.'))
    .map(entry=>({name:entry.name,path:[...(safeSegments(relative)),entry.name].join('/')}))
    .sort((a,b)=>a.name.localeCompare(b.name,'zh'))
    .slice(0,GRANT_FREE_LIST_LIMIT);
   return {path:safeSegments(relative).join('/'),parent:safeSegments(relative).slice(0,-1).join('/'),items:directories};
  },
  /** 在工作区里新建文件夹（用户要求：界面上能直接新建）。 */
  create(workspacePath,relative,name){
   if(typeof name!=='string'||!name.trim())throw new DomainError('INVALID','请填写文件夹名称');
   const clean=name.trim();
   if(clean==='.'||clean==='..'||clean.includes('/')||clean.includes('\0'))throw new DomainError('INVALID','文件夹名称不能包含斜杠或 ..');
   const base=resolveInside(workspacePath,relative,{mustExist:true});
   // macOS 上 /var 是指向 /private/var 的符号链接：边界比较必须用**真实**根，
   // 否则合法的新建会被误判成越界（这正是本用例第一次跑出来的问题）。
   const realRoot=realpathSync(base.root);
   const target=join(base.real??base.target,clean);
   if(!insideRoot(realRoot,target))throw new DomainError('FORBIDDEN','只能在工作台已授权的文件夹里新建');
   try{statSync(target);throw new DomainError('INVALID','同名文件或文件夹已存在：'+clean)}
   catch(error){if(error instanceof DomainError)throw error}
   try{mkdirSync(target)}catch(error){throw new DomainError('INVALID','新建失败：'+error.message)}
   return {name:clean,path:[...safeSegments(relative),clean].join('/'),label:basename(target)};
  },
 };
}
