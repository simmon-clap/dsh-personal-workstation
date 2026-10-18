import {DomainError} from './store.mjs';
/** Internal bridge. Caller must authorize execution and supply the exact live parent. */
export class SubagentExecutor {
 constructor(service,{provider,tools=[]}={}){
  if(typeof provider!=='string'||!provider.trim()||!Array.isArray(tools)||tools.some(t=>typeof t!=='string'||!t.trim()))throw new DomainError('INVALID','执行器配置无效');
  this.service=service;this.provider=provider;this.tools=[...new Set(tools)];
 }
 status(){const provider=this.service?.getProvider(this.provider);return {enabled:true,provider:!!provider,toolFilter:!!provider?.capabilities?.toolFilter,toolCount:this.tools.length};}
 async start({parent,signal,label,prompt}){
  if(!parent?.id||!signal||typeof signal.throwIfAborted!=='function'||typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw new DomainError('INVALID','执行上下文或提示词无效');
  signal.throwIfAborted();
  const provider=this.service?.getProvider(this.provider);
  if(!provider)throw new DomainError('UNAVAILABLE','指定执行提供方未接入');
  if(!provider.capabilities?.toolFilter)throw new DomainError('UNAVAILABLE','执行提供方不支持工具范围限制');
  return this.service.start(this.provider,{parent,signal,label,prompt:[{type:'text',text:prompt}],toolFilter:{allow:[...this.tools]}});
 }
}
