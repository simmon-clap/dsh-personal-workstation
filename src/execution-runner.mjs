import {DomainError} from './store.mjs';
import {executionResult} from './execution-result.mjs';
/** Foreground internal coordinator. Authorization belongs to its caller. */
export class ExecutionRunner {
 constructor(ledger,executor){this.ledger=ledger;this.executor=executor;this.shutdown=new AbortController();this.pending=new Set();}
 assertAvailable(){if(this.shutdown.signal.aborted)throw new DomainError('UNAVAILABLE','执行协调器已关闭');const status=this.executor.status();if(!status.provider)throw new DomainError('UNAVAILABLE','指定执行提供方未接入');if(!status.toolFilter)throw new DomainError('UNAVAILABLE','执行提供方不支持工具范围限制');}
 run(ctx,request,{parent,signal}){
  if(this.shutdown.signal.aborted)return Promise.reject(new Error('执行协调器已关闭'));
  const combined=AbortSignal.any([signal,this.shutdown.signal]);
  const operation=this.execute(ctx,request,{parent,signal:combined});this.pending.add(operation);
  operation.then(()=>this.pending.delete(operation),()=>this.pending.delete(operation));return operation;
 }
 close(){if(!this.closing){this.shutdown.abort(new Error('执行协调器正在关闭'));this.closing=Promise.allSettled([...this.pending]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'执行协调器关闭期间发生错误')})}return this.closing;}
 async execute(ctx,request,{parent,signal}){
  signal.throwIfAborted();const reserved=this.ledger.reserve(ctx,request);if(!reserved.created)return reserved.item;
  let item=reserved.item,handle,cancelError,primaryError;
  const recordCancel=()=>{try{const latest=this.ledger.get(ctx,item.id);if(latest?.status==='running')this.ledger.cancelRequested(ctx,item.id,latest.revision)}catch(error){cancelError=error}};
  try{
   if(item.taskSnapshot.executionTarget&&item.taskSnapshot.executionTarget!=='local')throw new DomainError('UNAVAILABLE','指定执行端尚未接入，未启动本机执行');
   handle=await this.executor.start({parent,signal,label:item.taskSnapshot.title,prompt:JSON.stringify({task:item.taskSnapshot,taskId:item.taskId,taskRevision:item.taskRevision})});
   const observed=Promise.resolve(handle.result).catch(()=>({stopReason:'error',output:[],diagnostic:'执行提供方结果读取失败'}));
   item=this.ledger.started(ctx,item.id,item.revision,handle.id);
   signal.addEventListener('abort',recordCancel,{once:true});if(signal.aborted)recordCancel();
   let result=await observed;
   try{executionResult(result)}catch{result={stopReason:'error',output:[],diagnostic:'执行提供方返回无效结果'}}
   const latest=this.ledger.get(ctx,item.id);const final=this.ledger.finish(ctx,item.id,latest.revision,result);if(cancelError)throw cancelError;return final;
  }catch(error){
    primaryError=error;
   try{const latest=this.ledger.get(ctx,item.id);if(latest?.status==='reserved')this.ledger.startFailed(ctx,item.id,latest.revision,'执行启动失败，请检查提供方状态')}catch(recordError){primaryError=new AggregateError([error,recordError],'执行失败且无法保存失败记录')}
   throw primaryError;
  }finally{signal.removeEventListener('abort',recordCancel);if(handle){try{await handle.dispose()}catch(disposeError){if(primaryError)throw new AggregateError([primaryError,disposeError],'执行及句柄清理均失败');throw disposeError}}}
 }
}
