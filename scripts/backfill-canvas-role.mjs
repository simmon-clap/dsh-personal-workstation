#!/usr/bin/env node
/** 画布角色数据 dry-run（批次 A1 / 决策门 D5）：**只读**，不写库。
 *
 *  背景：机构要有默认角色、项目要有角色模板与参与机构；但真实数据**不自动分类、不自动挂主责机构**。
 *  本脚本只如实列出「现在缺什么、建议怎么映射」，供 D5 决定后再由批次写入。
 *
 *  只读打开：`node:sqlite` 的 DatabaseSync(path,{readOnly:true}) 直接读；
 *  **不** new WorkstationStore —— 它的构造函数会跑 migrateScopes 写库。
 *
 *  用法：
 *    node scripts/backfill-canvas-role.mjs [--db <path>] [--json]
 *  默认库：~/DSH/飞书工作区/workstation-data/workstation.sqlite
 *  --apply 一律拒绝（exit 2）：D5 只做 dry-run，本批不写真实业务数据。
 */
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

const DEFAULT_DB='~/DSH/飞书工作区/workstation-data/workstation.sqlite';
const USAGE='用法：node scripts/backfill-canvas-role.mjs [--db <path>] [--json]';

const args=process.argv.slice(2);
// 写库入口一律拒绝：本批只做 dry-run（D5 未确认前不动真实业务数据）。
if(args.some(arg=>arg==='--apply'||arg==='--write'||arg.startsWith('--apply='))){console.error('拒绝：D5 只做 dry-run，本批不写真实业务数据');process.exit(2);}
let dbPath=DEFAULT_DB,asJson=false;
for(let i=0;i<args.length;i++){
 const arg=args[i];
 if(arg==='--json'){asJson=true;continue;}
 if(arg==='--db'){dbPath=args[++i];continue;}
 if(arg.startsWith('--db=')){dbPath=arg.slice('--db='.length);continue;}
 console.error('未知参数：'+arg+'\n'+USAGE);process.exit(2);
}
if(typeof dbPath!=='string'||!dbPath.trim()){console.error('--db 需要库文件路径\n'+USAGE);process.exit(2);}
if(!existsSync(dbPath)){console.error('库不存在：'+dbPath);process.exit(1);}

let db;
try{db=new DatabaseSync(dbPath,{readOnly:true});}catch(error){console.error('只读打开库失败：'+error.message);process.exit(1);}
try{
 // 旧库同一对象可能在多个作用域各有一份：按 id 去重，优先保留未归档的那份（只读统计，不写回）。
 const byId=new Map();
 for(const row of db.prepare('SELECT workspace,id,kind,archived,data FROM entities').all()){
  const previous=byId.get(row.id);
  if(!previous||(previous.archived&&!row.archived))byId.set(row.id,row);
 }
 const items=[...byId.values()].map(row=>{
  let data={},parsed=true;
  try{data=row.data?JSON.parse(row.data):{}}catch{parsed=false;}
  return {...row,data,parsed};
 });
 const unreadable=items.filter(item=>!item.parsed);
 const list=kind=>items.filter(item=>item.kind===kind);
 const active=kind=>list(kind).filter(item=>!item.archived);
 const organizations=active('organization'),projects=active('project');
 const roleOf=item=>typeof item.data.defaultRole==='string'?item.data.defaultRole.trim():'';
 const withDefaultRole=organizations.filter(item=>roleOf(item));
 const unclassified=organizations.filter(item=>!roleOf(item));
 const withTemplate=projects.filter(item=>typeof item.data.roleTemplate==='string'&&item.data.roleTemplate.trim());
 const withoutTemplate=projects.filter(item=>!(typeof item.data.roleTemplate==='string'&&item.data.roleTemplate.trim()));
 const templateCounts=new Map();
 for(const item of withTemplate){const key=item.data.roleTemplate;templateCounts.set(key,(templateCounts.get(key)??0)+1);}
 const participantProjects=projects.filter(item=>Array.isArray(item.data.participants)&&item.data.participants.length);
 let participantCount=0;
 for(const item of participantProjects)participantCount+=item.data.participants.length;
 // partnerId 是旧字段（兼容保留）：只给出**建议映射**，role 一律「待定，不自动填」，本脚本不写。
 const partnerIdWithoutParticipants=projects.filter(item=>typeof item.data.partnerId==='string'&&item.data.partnerId.trim()&&!(Array.isArray(item.data.participants)&&item.data.participants.length)).map(item=>({
  id:item.id,title:item.data.title??null,partnerId:item.data.partnerId,
  partnerIdExists:byId.has(item.data.partnerId)&&byId.get(item.data.partnerId).kind==='organization'&&!byId.get(item.data.partnerId).archived,
  suggested:{organizationId:item.data.partnerId,role:'待定，不自动填'},
 }));
 const unowned=projects.filter(item=>!item.data.organizationId);
 const invalidParticipants=[];
 for(const project of participantProjects){
  for(const entry of project.data.participants){
   const organizationId=entry&&typeof entry==='object'?entry.organizationId:undefined;
   const target=typeof organizationId==='string'?byId.get(organizationId):null;
   const reason=!target||target.kind!=='organization'?'不存在':target.archived?'已归档':null;
   if(reason)invalidParticipants.push({projectId:project.id,title:project.data.title??null,organizationId:organizationId??null,reason});
  }
 }
 const report={
  db:dbPath,readOnly:true,
  organizations:{
   total:organizations.length,archived:list('organization').length-organizations.length,
   withDefaultRole:withDefaultRole.length,unclassified:unclassified.length,
  },
  projects:{
   total:projects.length,archived:list('project').length-projects.length,
   withRoleTemplate:withTemplate.length,withoutRoleTemplate:withoutTemplate.length,
   templates:Object.fromEntries(templateCounts),
   withOrganizationId:projects.length-unowned.length,
   unowned:unowned.map(item=>({id:item.id,title:item.data.title??null})),
   withParticipants:participantProjects.length,participantCount,
   partnerIdWithoutParticipants,invalidParticipants,
  },
  unreadable:unreadable.length,
 };
 if(asJson){console.log(JSON.stringify(report,null,2));}
 else{
  console.log('画布角色数据 dry-run（只读，不写库）');
  console.log('库：'+dbPath);
  console.log('');
  console.log('组织（未归档）：共 '+organizations.length+' / 有默认角色 '+withDefaultRole.length+' / 未分类 '+unclassified.length+'（已归档 '+report.organizations.archived+'）');
  console.log('项目（未归档）：共 '+projects.length+' / 有角色模板 '+withTemplate.length+' / 未套模板 '+withoutTemplate.length+'（已归档 '+report.projects.archived+'）');
  console.log('参与者：已有参与机构的项目 '+participantProjects.length+' 个 / 条目 '+participantCount+' 条');
  console.log('建议映射（有 partnerId 但无参与者，role 待定、不自动填）：'+partnerIdWithoutParticipants.length+' 个项目');
  for(const item of partnerIdWithoutParticipants)console.log('  - '+item.id+' '+(item.title??'（无标题）')+'：partnerId '+item.partnerId+(item.partnerIdExists?'':'（该机构不存在或已归档，先别映射）')+' → participants [{organizationId, role:「待定，不自动填」}]');
  console.log('未归属（没有主责机构 organizationId）：'+unowned.length+' 个项目');
  for(const item of unowned)console.log('  - '+item.id+' '+(item.data.title??'（无标题）'));
  console.log('参与者引用失效的组织：'+invalidParticipants.length+' 条');
  for(const item of invalidParticipants)console.log('  - 项目 '+item.projectId+' '+(item.title??'')+' → 机构 '+item.organizationId+'（'+item.reason+'）');
  if(unreadable.length)console.log('无法解析的实体（data 不是合法 JSON）：'+unreadable.length+' 条');
  console.log('');
  console.log('dry-run：没有写任何东西。D5 确认后另开批次写，不在本批动真实业务数据。');
 }
}catch(error){
 // 只读统计失败也如实报错，不静默当成 0 条。
 console.error('读取失败：'+(error?.message??error));
 process.exitCode=1;
}finally{db.close();}
