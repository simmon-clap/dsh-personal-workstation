import {abortableWait} from './abort-wait.mjs';
import {DomainError} from './store.mjs';
/** Explicit workspace/base grants; local lexical retrieval never invokes reranking. */
export class KnowledgeAdapter {
 get service(){return this.closed?undefined:this.resolveService();}
  set service(value){this.resolveService=()=>value;}
  constructor(service,grants=[],resolveService){this.resolveService=resolveService??(()=>service);this.grants=grants;this.closed=false;this.controller=new AbortController();}
 close(){this.closed=true;this.grants=[];this.service=undefined;this.controller.abort(new DomainError('UNAVAILABLE','知识适配器已关闭'));}
 async search(ctx,{baseId,query,topK=10},callerSignal){
  callerSignal?.throwIfAborted();const deadlineAt=Date.now()+15000;const timeout=AbortSignal.timeout(15000);const signal=AbortSignal.any([this.controller.signal,timeout,...(callerSignal?[callerSignal]:[])]);
  const authorized=()=>!this.closed&&this.grants.some(g=>g.workspace===ctx.workspace&&g.baseId===baseId);if(!authorized())throw new DomainError('FORBIDDEN','知识库未授权给当前工作区');
  const service=this.service;if(!service)throw new DomainError('UNAVAILABLE','知识服务未接入');
  if(typeof query!=='string'||!query.trim()||query.length>500||!Number.isInteger(topK)||topK<1||topK>20)throw new DomainError('INVALID','检索参数无效');
  // Older providers may lack catalog lookup; current dsh-knowledge exposes it synchronously.
  const checkBase=()=>{if(typeof service.listBases==='function'&&!service.listBases().some(base=>base.id===baseId))throw new DomainError('NOT_FOUND','授权的知识库已不存在，请更新知识库授权配置');};checkBase();
  let result;try{result=await abortableWait(service.search({baseId,query:query.trim(),topK,mode:'lexical'},{rerank:'skip',signal,deadlineAt}),signal);}catch(error){callerSignal?.throwIfAborted();if(timeout.aborted||Date.now()>=deadlineAt)throw new DomainError('UNAVAILABLE','知识检索超时，请稍后重试');throw error;}
  if(!authorized())throw new DomainError('FORBIDDEN','检索期间知识库授权已撤销');
  if(this.service!==service)throw new DomainError('UNAVAILABLE','知识服务已变更，请重新检索');callerSignal?.throwIfAborted();if(timeout.aborted||Date.now()>=deadlineAt)throw new DomainError('UNAVAILABLE','知识检索超时，请稍后重试');checkBase();
  if(!result||!Array.isArray(result.hits)||result.hits.length>topK||result.hits.some(hit=>!hit||hit.baseId!==baseId||['docId','chunkId'].some(key=>typeof hit[key]!=='string'||!hit[key].trim())||typeof hit.documentTitle!=='string'||typeof hit.text!=='string'))throw new DomainError('INTERNAL','知识服务返回无效或越界证据');
  if(result.retrieval?.lexical?.attempted&&result.retrieval.lexical.succeeded===false)throw new DomainError('UNAVAILABLE','知识词法检索失败，请稍后重试；不能据此判断没有证据');
  return result;
 }
}
