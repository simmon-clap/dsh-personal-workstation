import {mkdirSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,parse,resolve} from 'node:path';
import {DomainError} from './store.mjs';

/** 运行时目录授权：用户在「空间与设置」里点授权即可生效，不必再改配置文件、不必重启。
 *  规则与配置里的 fileGrants 完全一致（同一套校验），另外多两条：
 *   · 授权根必须**确实存在且是目录**（避免授权一个笔误路径然后反复困惑）；
 *   · 授权根必须**位于该工作区目录之内**（工作区是数据边界，不能借授权越出它）。
 *  写入用临时文件 + 改名，避免半截文件。 */
export function validateRoot(root,{workspaceRoot}={}){
 if(typeof root!=='string'||!root.trim()||!isAbsolute(root))throw new DomainError('INVALID','目录授权必须是绝对路径');
 const target=resolve(root);
 if(target===parse(target).root)throw new DomainError('INVALID','不能把文件系统根目录授权给工作台');
 if(workspaceRoot&&!(target===resolve(workspaceRoot)||target.startsWith(resolve(workspaceRoot)+'/')))throw new DomainError('FORBIDDEN','只能授权工作台数据目录里的文件夹：'+workspaceRoot);
 return target;
}

export function createGrantStore({directory,workspaceRoots=()=>({})}){
 const file=join(directory,'grants.json');
 let grants=load();
 function load(){
  try{
   const raw=readFileSync(file,'utf8');
   const parsed=JSON.parse(raw);
   if(!Array.isArray(parsed))return [];
   return parsed.filter(grant=>grant&&typeof grant==='object'&&typeof grant.id==='string'&&typeof grant.root==='string');
  }catch{return []}
 }
 function save(){
  mkdirSync(directory,{recursive:true});
  const temporary=file+'.tmp';
  writeFileSync(temporary,JSON.stringify(grants,null,2),'utf8');
  renameSync(temporary,file);
 }
 return {
  file,
  list(workspace){return grants.filter(grant=>!workspace||grant.workspace===workspace).map(grant=>({...grant}))},
  all(){return grants.map(grant=>({...grant}))},
  get(id){return grants.find(grant=>grant.id===id)},
  /** 新增（或按 id 更新）一个运行时授权。 */
  add({id,workspace,root,read=true,write=false,label}={}){
   if(typeof id!=='string'||!id.trim())throw new DomainError('INVALID','授权需要一个标识');
   if(typeof workspace!=='string'||!workspace.trim())throw new DomainError('INVALID','授权必须绑定工作区');
   if(typeof read!=='boolean'||typeof write!=='boolean'||(write&&!read))throw new DomainError('INVALID','授权权限不合法：写权限必须同时有读权限');
   const workspaceRoot=workspaceRoots()[workspace];
   const target=validateRoot(root,{workspaceRoot});
   let info=null;
   try{info=statSync(target)}catch{throw new DomainError('INVALID','目录不存在：'+target)}
   if(!info.isDirectory())throw new DomainError('INVALID','只能授权文件夹，不能授权单个文件：'+target);
   const existing=grants.findIndex(grant=>grant.id===id);
   const record={id,workspace,root:target,read,write,label:typeof label==='string'&&label.trim()?label.trim():target.split('/').pop()||target};
   if(existing>=0)grants[existing]=record;else grants.push(record);
   save();
   return {...record};
  },
  remove(id){const before=grants.length;grants=grants.filter(grant=>grant.id!==id);if(grants.length===before)throw new DomainError('NOT_FOUND','没有这条授权：'+id);save();return {removed:id}},
 };
}
