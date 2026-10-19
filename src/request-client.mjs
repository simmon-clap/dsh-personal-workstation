export const requestClient=`
function scopedApi(scope,send,isCurrent){return async(action,data={})=>{
 if(!isCurrent())throw new Error('数据刚更新过，请重新操作。');
 const value=await send(action,data,scope);
 if(!isCurrent())throw new Error('工作区已切换；原请求可能已在原工作区完成，请查询记录编号。');
 return value;
}}
`;
