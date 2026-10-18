/** 记录与文件的分阶段状态（PRD v1.3 CH-05：跨服务修改显示分阶段结果，不承诺原子事务）。
 *  数据库里的资料记录与文件系统上的文件是两套状态：文件可能被改动、删除或授权被撤回，
 *  记录仍然存在。这里只读比较两者，如实报告是哪一边变了，不自动改写记录、不假装一致。 */

export const artifactStates=Object.freeze({
 current:'记录与文件一致',
 changed:'文件已变化，记录仍指向旧版本',
 missing:'文件不存在',
 ungranted:'没有可用的文件授权',
 unknown:'无法确认',
});

export async function artifactState(files,ctx,artifact){
 const data=artifact?.data??{};
 if(typeof data.path!=='string'||!data.path.trim())return {status:'unknown',reason:'该记录没有文件路径',checkedAt:new Date().toISOString()};
 if(typeof data.fileGrantId!=='string'||!data.fileGrantId)return {status:'unknown',reason:'该记录没有关联文件授权',checkedAt:new Date().toISOString()};
 if(!files?.version)return {status:'unknown',reason:'宿主未加载文件服务',checkedAt:new Date().toISOString()};
 let info;
 try{info=await files.version(ctx,{grantId:data.fileGrantId,path:data.path})}
 catch(error){
  const code=error?.code;
  if(code==='FORBIDDEN')return {status:'ungranted',reason:error.message,checkedAt:new Date().toISOString()};
  return {status:'unknown',reason:error?.message??'读取文件状态失败',checkedAt:new Date().toISOString()};
 }
 const checkedAt=new Date().toISOString();
 if(!info.exists)return {status:'missing',recordVersion:data.fileVersion??null,currentVersion:null,checkedAt};
 if(!data.fileVersion)return {status:'unknown',reason:'记录未保存文件版本，无法比较',currentVersion:info.version??null,checkedAt};
 if(info.version!==data.fileVersion)return {status:'changed',recordVersion:data.fileVersion,currentVersion:info.version??null,size:info.size,checkedAt};
 return {status:'current',version:info.version??null,size:info.size,checkedAt};
}
