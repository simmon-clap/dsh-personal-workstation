import {DomainError} from './store.mjs';
/** Execution outcome only; never mutates a business task's status. */
export function executionResult(result){
 const states={completed:'completed',aborted:'cancelled',error:'failed','max-tokens':'incomplete',refusal:'refused'};
 if(!result||!Object.hasOwn(states,result.stopReason)||!Array.isArray(result.output))throw new DomainError('INVALID','执行器返回无效结果');
 const text=result.output.filter(block=>block?.type==='text').map(block=>{if(typeof block.text!=='string')throw new DomainError('INVALID','执行器文本结果无效');return block.text}).join('\n');
 return {status:states[result.stopReason],stopReason:result.stopReason,text,...(typeof result.diagnostic==='string'?{diagnostic:result.diagnostic}:{})};
}
