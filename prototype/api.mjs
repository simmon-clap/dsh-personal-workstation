export function createWorkspaceApi(workspace,{fetch:request=globalThis.fetch,isCurrent=()=>true}={}){
 return async function send(action,data={}){
  if(!isCurrent())throw Error('数据刚更新过，请重试');
  let response;
  try{
   response=await request('/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace})});
  }catch{
   // 断连：错误必须可操作，并说明重试安全（提交复用同一幂等键，不会重复写入）。
   if(!isCurrent())throw Error('数据刚更新过，请重试');
   throw Error('无法连接工作台服务（网络中断或服务未启动）。请检查连接后重试。重试是安全的：同一次操作只会生效一次，不会重复写入。');
  }
  if(!isCurrent())throw Error('数据刚更新过，请重试');
  let value;
  try{value=await response.json()}
  catch{
   if(!isCurrent())throw Error('数据刚更新过，请重试');
   // 半途断开或网关错误页：不能把解析失败当成业务失败，也不能当作成功。
   throw Error('工作台返回了无法解析的响应（HTTP '+response.status+'）。请刷新后重试，尚不确定本次操作是否生效。');
  }
  if(!isCurrent())throw Error('数据刚更新过，请重试');
  if(!response.ok){
   // **必须把 code 带上**：上层要靠它区分"版本冲突"和别的失败。
   // 只抛 message 会让 batch.mjs 里 `error?.code==='CONFLICT'` 的重放分支变成死代码 ——
   // 于是版本冲突不再自动重放，而是当成一次普通失败。
   const error=Error(value?.message||value?.error||('工作台请求失败（HTTP '+response.status+'）'));
   // **服务端把错误码放在 `error` 字段**（见 src/api-error.mjs：body = {error: code, message}），
   // 不是 `code`。上一版我读的是 value.code —— 读错了字段，等于没修。
   // 只认全大写下划线的形状，避免把一句人话当成错误码挂上去。
   const code=value?.code??value?.error;
   if(typeof code==='string'&&/^[A-Z][A-Z_]*$/.test(code))error.code=code;
   throw error;
  }
  return value;
 };
}

export async function readWorkspaceItems(send){
 const items=[],seen=new Set();let offset=0;
 for(;;){const result=await send('list',{limit:200,offset,includeArchived:false});
  if(!Array.isArray(result.items))throw Error('工作台数据响应无效');
  for(const item of result.items){if(seen.has(item.id))throw Error('读取期间数据变化，请刷新重试');seen.add(item.id);items.push(item);}
  if(result.items.length<200)return items;
  offset+=200;if(offset>=10000)throw Error('数据超过当前读取范围，不能显示不完整统计');
 }
}
