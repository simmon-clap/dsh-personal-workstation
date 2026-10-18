/** 资料 → 知识库收录，以及收录后的真实索引状态（PRD v1.0 KN-05 / v1.1 IN-AC-8）。
 *  写入与索引都由宿主 dsh-knowledge 服务负责：本插件只做**授权范围内的路径解析**与调用，
 *  不自己解析文档、不自己建索引。状态的判断只依据服务返回的原始字段，
 *  读不到就说读不到，绝不把「未确认」说成「已完成」。 */

export const INDEX_PHASES=Object.freeze({pending:'排队中',processing:'正在处理',downloading:'下载中',validating:'检查中',ready:'已完成',indexed:'已完成',complete:'已完成',failed:'失败',error:'失败'});

/** 原始状态 → 阶段；未知状态原样带回，不猜测。 */
export function phaseOf(rawStatus){
 if(typeof rawStatus!=='string'||!rawStatus)return {phase:'unknown',raw:null};
 return {phase:INDEX_PHASES[rawStatus]?rawStatus:'unknown',raw:rawStatus};
}
const asProgress=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(100,Math.round(value))):null;

/** 只读：查一个已登记文档的当前索引状态。 */
export async function knowledgeState(service,{baseId,documentId}={}){
 if(!service?.listDocuments)return {available:false,reason:'宿主未加载知识库服务，无法确认知识库状态'};
 if(typeof baseId!=='string'||!baseId)return {available:false,reason:'未记录知识库归属'};
 if(typeof documentId!=='string'||!documentId)return {available:false,reason:'未记录知识库文档标识'};
 let documents;
 try{documents=await service.listDocuments(baseId)}
 catch(error){return {available:false,reason:'读取知识库文档失败：'+(error?.message??'未知原因')}}
 if(!Array.isArray(documents))return {available:false,reason:'知识库返回的文档列表无效'};
 const document=documents.find(item=>item?.id===documentId);
 if(!document)return {available:true,status:'not-found',reason:'知识库中已找不到该文档（可能已被删除）',baseId,documentId};
 let job=null;
 try{job=await service.getJob?.(baseId,documentId)??null}catch{job=null}
 const raw=job?.status??document.status??null;
 const {phase}=phaseOf(raw);
 return {
  available:true,status:phase,rawStatus:raw,baseId,documentId,
  progress:asProgress(job?.progress??document.progress),
  chunkCount:Number.isInteger(document.chunkCount)?document.chunkCount:null,
  message:typeof job?.error==='string'?job.error:(typeof document.error==='string'?document.error:null),
  reason:phase==='unknown'?(raw?('知识库返回了未识别的状态：'+raw):'知识库没有返回状态字段'):null,
 };
}

/** 收录一个授权目录内的文件。返回宿主给出的文档标识与**当时**的状态，不承诺索引已完成。 */
export async function ingestFile({service,files,ctx,grantId,path,baseId}){
 if(!service?.importFileFromPath)throw Object.assign(new Error('宿主未加载知识库服务，无法存进知识库'),{code:'UNAVAILABLE'});
 if(typeof baseId!=='string'||!baseId)throw Object.assign(new Error('必须指定要存进知识库到的知识库'),{code:'INVALID'});
 const file=await files.hostPath(ctx,{grantId,path});
 const document=await service.importFileFromPath(baseId,file.hostPath);
 const {phase}=phaseOf(document?.status);
 return {baseId,documentId:document?.id??null,path,status:phase,rawStatus:document?.status??null,chunkCount:Number.isInteger(document?.chunkCount)?document.chunkCount:null};
}
