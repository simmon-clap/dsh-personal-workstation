/** 批次来源指令：从会话原文里取**用户消息**，让工作台结果可追溯到具体指令。
 *  PRD v1.1 IN-AC-10「上传材料、原始对话和确认版本可追溯」。
 *  只读；只取用户角色的消息，不取模型或工具内容；条数与字符数都有上限。
 *  会话服务缺失或读取失败时如实返回不可用，不用摘要冒充原文。 */

export const ORIGIN_MESSAGE_LIMIT=5;
export const ORIGIN_TOTAL_CHARS=2400;

// 截断后的长度必须 <= limit：省略号也占一个字符。
const clip=(text,limit)=>{if(typeof text!=='string')return '';if(limit<=0)return '';return text.length>limit?text.slice(0,Math.max(0,limit-1))+'…':text};

export async function readBatchOrigin(sessionQuery,sessionId,{limit=ORIGIN_MESSAGE_LIMIT,maxChars=ORIGIN_TOTAL_CHARS,signal}={}){
 if(typeof sessionId!=='string'||!sessionId)return {available:false,reason:'这次改动没有记录来源会话（人工录入）',messages:[]};
 if(!sessionQuery?.filterEvents)return {available:false,reason:'宿主未加载会话查询服务，无法读取原始指令',messages:[]};
 let documents;
 try{documents=await sessionQuery.filterEvents(sessionId,[{kind:'type',values:['user/message']}],signal?{signal}:undefined)}
 catch(error){return {available:false,reason:'读取会话原文失败：'+(error?.message??'未知原因'),messages:[]}}
 if(!Array.isArray(documents))return {available:false,reason:'会话原文响应无效',messages:[]};
 let title=null;
 try{title=(await sessionQuery.readTitle?.(sessionId))?.title??null}catch{title=null}
 const picked=documents.slice(-limit);
 const messages=[];let used=0,truncated=false;
 // 从最近一条往回分配字符预算，保证最新的指令一定完整可见。
 for(const document of [...picked].reverse()){
  const budget=Math.max(0,maxChars-used);
  if(budget<=0){truncated=true;break}
  const text=clip(document?.text??'',Math.min(budget,800));
  if(text.length<((document?.text??'').length))truncated=true;
  used+=text.length;
  messages.unshift({seq:document?.seq??null,at:document?.time??null,text});
 }
 if(documents.length>picked.length)truncated=true;
 return {available:true,sessionId,title,count:documents.length,messages,truncated};
}
