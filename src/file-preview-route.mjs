import {PREVIEW_FILE_MAX_BYTES,OFFICE_SOURCE_MAX_BYTES} from './limits.mjs';

/** 浏览器原生渲染的文件类型与 MIME。
 *  PRD v1.1 FL-02 要求「不在插件内新建字节处理链路」：这里只做受权读取与 MIME 声明。
 *  图片与 PDF 交给浏览器渲染；Office 交给宿主的 officeToPdf 服务转换后再由浏览器渲染 PDF。 */
export const previewTypes=Object.freeze({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',pdf:'application/pdf'});
export const previewExtensions=Object.freeze(Object.keys(previewTypes));
/** **录音**单独一组（2026-10-16 补）：宪章判据 3 要"追回录音或文件的那一段"。
 *  录音不能像图片那样"整个读进来" —— 真实的一条会议录音有 52MB，而预览上限是 32MB；
 *  而且播放器要能拖动进度条，就必须支持按范围取字节（HTTP Range）。
 *  所以录音走另一条路：`readByteRange` 只取窗口，并按 206 响应。 */
export const audioTypes=Object.freeze({m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',aac:'audio/aac',ogg:'audio/ogg',flac:'audio/flac'});
export const audioExtensions=Object.freeze(Object.keys(audioTypes));
/** 单次响应的字节窗口上限（2MB）：既不把 52MB 一次性塞进内存，也足够播放器连续取流。 */
export const AUDIO_WINDOW_MAX_BYTES=2*1024*1024;
/** Office 需要宿主转换服务；扩展名与 officeToPdf 声明的 OfficeExtension 一致。 */
export const officeExtensions=Object.freeze(['doc','docx','xls','xlsx','ppt','pptx']);
export const officeMime='application/pdf';

const failure=(status,message)=>new Response(message,{status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
export const previewPath='/personal-workstation/file';

/** 受权文件字节路由：工作区必须在授权清单内，文件必须落在授权目录内，类型必须可渲染。 */
export function filePreviewRoute(deps){
 return {path:previewPath,methods:['GET'],requestBody:'buffered',async fetch(request){
  const admission=deps.connection.admit({headers:request.headers});
  if('rejection' in admission)return failure(admission.rejection,'Unauthorized');
  const url=new URL(request.url);
  const workspace=url.searchParams.get('workspace')??'';
  const grantId=url.searchParams.get('grantId')??'';
  const path=url.searchParams.get('path')??'';
  const suffix=path.trim().toLowerCase().split('.').pop();
  if(!deps.files)return failure(503,'文件服务未接入');
  // 允许列表可能是配置数组，也可能是"配置 ∪ 界面运行时授权"的取函数；不缓存，界面刚授权的要立刻生效。
  const allowed=deps.allowedWorkspaces;
  const allowedList=()=>typeof allowed==='function'?allowed():allowed??[];
  if(!allowedList().includes(workspace))return failure(403,'工作区未授权');
  const actor=admission.peer?.id??'client';
  const ctx={workspace,actor,canWrite:false};
  const headers={'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",'content-disposition':'inline','cache-control':'no-store','x-content-type-options':'nosniff'};
  try{
   if(officeExtensions.includes(suffix)){
    // 转换引擎属于宿主；插件只提供受权读取，不在自己这里解析 Office。
    if(!deps.office)return failure(503,'Office 预览需要宿主转换服务（officeToPdf），当前未加载');
    const source=await deps.files.readBinary(ctx,{grantId,path,extensions:officeExtensions,label:'Office 预览',maxBytes:OFFICE_SOURCE_MAX_BYTES,limitMessage:'Office 文件超过预览大小限制'});
    const result=await deps.office.convert({
     extension:suffix,priority:'foreground',
     source:{key:workspace+'|'+grantId+'|'+path,version:source.version,bytes:source.size,read:async(signal,maxBytes)=>{signal?.throwIfAborted();if(maxBytes<source.size)throw Object.assign(new Error('Office 文件超过预览大小限制'),{code:'INVALID'});return {bytes:source.bytes,version:source.version}}},
    },request.signal);
    if(!result?.pdf)return failure(502,'Office 转换未返回 PDF');
    return new Response(result.pdf,{headers:{...headers,'content-type':officeMime,'x-office-missing-fonts':String((result.missingFonts??[]).length),...(result.missingFonts?.length?{'x-office-missing-font-list':encodeURIComponent(result.missingFonts.slice(0,10).join(','))}:{})}});
   }
   // 录音：按 Range 取窗口（支持拖动进度条，且不需要把整个文件读进内存）。
   if(audioExtensions.includes(suffix)){
    const window=await readAudioWindow({deps,ctx,grantId,path,request});
    if('failure' in window)return window.failure;
    return window.response;
   }
   const file=await deps.files.readBinary(ctx,{grantId,path,extensions:previewExtensions,label:'预览',maxBytes:PREVIEW_FILE_MAX_BYTES,limitMessage:'文件超过预览大小限制'});
   const type=previewTypes[suffix]??'application/octet-stream';
   return new Response(file.bytes,{headers:{...headers,'content-type':type}});
  }catch(error){
   if(error?.name==='AbortError')return failure(499,'预览已取消');
   const status=error?.code==='FORBIDDEN'?403:error?.code==='CONFLICT'?409:error?.code==='TOO_LARGE'?413:error?.code==='INVALID'?400:error?.code==='OFFICE_TO_PDF'||error?.name==='OfficeToPdfError'?502:404;
   return failure(status,error?.message??'读取失败');
  }
 }};
}

/** 解析 `Range: bytes=a-b`（只支持单段；播放器实际就发这个形状）。
 *  解析不出来就按"从头取一个窗口"处理 —— 不假装支持，也不整个返回。 */
function parseRange(header,total){
 if(typeof header!=='string')return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
 if(!match)return null;
 const [,rawStart,rawEnd]=match;
 if(rawStart===''&&rawEnd==='')return null;
 if(rawStart===''){
  const length=Number(rawEnd);
  if(!Number.isFinite(length)||length<=0)return null;
  return {start:Math.max(0,total-length),end:total-1};
 }
 const start=Number(rawStart);
 const end=rawEnd===''?total-1:Number(rawEnd);
 if(!Number.isFinite(start)||start<0||start>=total)return {unsatisfiable:true};
 if(!Number.isFinite(end)||end<start)return null;
 return {start,end:Math.min(end,total-1)};
}

/** 录音窗口：读一个字节区间并拼 206/200。窗口长度有上限，绝不把整个文件读进来。 */
async function readAudioWindow({deps,ctx,grantId,path,request}){
 const suffix=path.trim().toLowerCase().split('.').pop();
 const type=audioTypes[suffix];
 const info=await deps.files.version(ctx,{grantId,path});
 if(!info?.exists||info.type!=='file')return {failure:failure(404,'文件不存在或不是普通文件')};
 const total=Number(info.size??0);
 const parsed=parseRange(request.headers.get('range'),total);
 if(parsed?.unsatisfiable)return {failure:new Response('读取范围超出文件大小',{status:416,headers:{'content-range':'bytes */'+total,'content-type':'text/plain; charset=utf-8'}})};
 const start=Math.max(0,parsed?.start??0);
 const end=Math.min(parsed?.end??total-1,start+AUDIO_WINDOW_MAX_BYTES-1,total-1);
 const window=await deps.files.readRange(ctx,{grantId,path,start,end,extensions:audioExtensions,label:'录音播放',maxBytes:Infinity});
 const body=window.bytes;
 const headers={
  'content-type':type,
  'content-disposition':'inline',
  'cache-control':'no-store',
  'x-content-type-options':'nosniff',
  'accept-ranges':'bytes',
  'content-length':String(body.length),
  'content-range':'bytes '+start+'-'+(start+body.length-1)+'/'+total,
  'content-security-policy':"default-src 'none'; media-src 'self'",
 };
 return {response:new Response(body,{status:206,headers})};
}
