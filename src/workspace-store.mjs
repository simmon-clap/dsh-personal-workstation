import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DomainError} from './store.mjs';

/** 运行时工作区授权：用户在「空间与设置 → 工作区授权」里点一下即可生效，不必改配置文件、不必重启。
 *  与配置文件里的 allowedWorkspaces 合并后由同一处授权闸门**实时**读取（所以这里不缓存集合）。
 *  规则：只能授权 DSH 已经注册的工作区（清单来自 workspaceRegistry，界面不允许手填 id）；
 *  配置文件里那条永远不在这里撤销——界面只撤销自己加的那些，避免"点一下把配置授权也删了"。
 *  写入用临时文件 + 改名，避免半截文件。 */
export function createWorkspaceStore({directory}){
 const file=join(directory,'workspaces.json');
 let ids=load();
 function load(){
  try{
   const parsed=JSON.parse(readFileSync(file,'utf8'));
   if(!Array.isArray(parsed))return [];
   return [...new Set(parsed.filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()))];
  }catch{return []}
 }
 function save(){
  mkdirSync(directory,{recursive:true});
  const temporary=file+'.tmp';
  writeFileSync(temporary,JSON.stringify(ids,null,2),'utf8');
  renameSync(temporary,file);
 }
 const key=value=>{const id=String(value??'').trim();if(!id)throw new DomainError('INVALID','需要工作区 id');return id};
 return {
  file,
  list(){return [...ids]},
  has(id){return ids.includes(String(id??'').trim())},
  /** 新增一条运行时授权；已在里面时返回 added:false，不重复写盘。 */
  add(value){const id=key(value);if(ids.includes(id))return {id,added:false};ids.push(id);save();return {id,added:true}},
  /** 撤销一条运行时授权；本来就没有时返回 removed:false。 */
  remove(value){const id=key(value);const index=ids.indexOf(id);if(index<0)return {id,removed:false};ids.splice(index,1);save();return {id,removed:true}}
 };
}
