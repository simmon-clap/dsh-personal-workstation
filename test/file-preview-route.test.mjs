import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {canonicalWav} from './helpers/wav.mjs';

// PRD v1.1 FL-02：图片与 PDF 预览复用既有渲染能力，插件不做解析；字节只从受权目录流出。
function boot({peer='operator',read=true,bytes=Buffer.from('PNGDATA'),office=undefined}={}){
 const store=new WorkstationStore(':memory:');
 let lastPath=null;
 const files={
  // 录音播放走的是"按范围读"（真实 HostFiles.readRange → 宿主 fs.readByteRange）。
  // 桩里不补这两个，录音那条路在测试里根本走不到 —— 桩比宿主弱，测试就比现实弱。
  async version(ctx,{grantId,path}){
   lastPath=path;
   if(!read)throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});
   if(path.includes('missing'))return {exists:false,type:null,size:null,version:null};
   return {exists:true,type:'file',size:bytes.length,version:'v1'};
  },
  async readRange(ctx,{grantId,path,start=0,end=null,extensions=[]}){
   lastPath=path;
   if(!read)throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});
   const suffix=path.toLowerCase().split('.').pop();
   if(extensions.length&&!extensions.includes(suffix))throw Object.assign(new Error('录音播放只接受 '+extensions.join('、')),{code:'INVALID'});
   const to=end===null?bytes.length-1:Math.min(end,bytes.length-1);
   return {bytes:bytes.subarray(start,to+1),size:bytes.length,start,end:to};
  },
  async readBinary(ctx,{grantId,path,extensions,label,maxBytes=32*1024*1024}){
  lastPath=path;
  const suffix=path.toLowerCase().split('.').pop();
  if(!extensions.includes(suffix))throw Object.assign(new Error(label+'只接受授权目录内的 '+extensions.map(e=>'.'+e).join('、')+' 文件'),{code:'INVALID'});
  if(!read)throw Object.assign(new Error('文件授权不足'),{code:'FORBIDDEN'});
  if(path.includes('..'))throw Object.assign(new Error('文件超出授权目录'),{code:'FORBIDDEN'});
  if(path.includes('huge'))throw Object.assign(new Error('文件超过预览最多'),{code:'TOO_LARGE'});
  if(bytes.length>maxBytes)throw Object.assign(new Error('文件超过预览最多'),{code:'TOO_LARGE'});
  return {bytes,version:'v1',size:bytes.length};
 }};
 const connection={admit:({headers})=>peer&&headers?{peer:{id:peer}}:{rejection:401},requestRejection:({headers})=>peer&&headers?undefined:401};
 const route=httpRoute({store,files,office,connection,workspaceRegistry:{list:()=>[{id:'w',title:'W'}],get:id=>id==='w'?{id:'w'}:null},allowedWorkspaces:['w']});
 return {store,route,last:()=>lastPath};
}
async function open(booted){
 const server=createServer((q,s)=>booted.route.handler(q,s));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
const url=(base,params)=>base+'/personal-workstation/file?'+new URLSearchParams(params).toString();
test('an authorized image is served with its real MIME and cannot execute anything',async()=>{
 const booted=boot();const server=await open(booted);
 try{
  const response=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'pics/photo.png'}));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('content-disposition'),'inline');
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/,'预览内容必须按不可信处理，禁止加载脚本或外部资源');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(),'PNGDATA');
  assert.equal(booted.last(),'pics/photo.png');
 }finally{await server.close();booted.store.close()}
});
test('PDF is served as application/pdf so the browser uses its built-in viewer',async()=>{
 const booted=boot({bytes:Buffer.from('%PDF-1.7')});const server=await open(booted);
 try{
  const response=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'docs/合同.pdf'}));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf');
 }finally{await server.close();booted.store.close()}
});
test('unsupported formats and escaping paths are refused instead of streamed',async()=>{
 const booted=boot();const server=await open(booted);
 try{
  const docx=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'docs/report.docx'}));
  assert.equal(docx.status,503,'未接入 Office 转换服务时必须明确未接入');
  assert.match(await docx.text(),/Office 预览需要宿主转换服务/,'不能把「没有转换服务」说成文件有问题');
  assert.equal((await fetch(url(server.base,{workspace:'w',grantId:'g',path:'../secret.png'}))).status,403);
  assert.equal((await fetch(url(server.base,{workspace:'other',grantId:'g',path:'a.png'}))).status,403,'未授权工作区必须被拒');
  const huge=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'big/huge.png'}));
  assert.equal(huge.status,413,'超限必须与格式不支持区分开');
 }finally{await server.close();booted.store.close()}
});
test('a revoked grant and an unauthenticated caller never receive bytes',async()=>{
 const revoked=boot({read:false});const revokedServer=await open(revoked);
 try{
  const response=await fetch(url(revokedServer.base,{workspace:'w',grantId:'g',path:'a.png'}));
  assert.equal(response.status,403);
  assert.match(await response.text(),/文件授权不足/);
 }finally{await revokedServer.close();revoked.store.close()}
 const anonymous=boot({peer:null});const anonymousServer=await open(anonymous);
 try{
  assert.equal((await fetch(url(anonymousServer.base,{workspace:'w',grantId:'g',path:'a.png'}))).status,401);
 }finally{await anonymousServer.close();anonymous.store.close()}
});

test('the client-side preview list matches the server-side accepted formats',async()=>{
 const [server,client]=await Promise.all([import('../src/file-preview-route.mjs'),import('../prototype/preview-types.mjs')]);
 assert.deepEqual(Object.keys(client.audioTypes??{}).sort(),[...server.audioExtensions??[]].sort(),'录音类型两侧必须一致（判据 3：录音要能跳到那一段）');
 assert.deepEqual(Object.keys(client.previewTypes).sort(),[...server.previewExtensions].sort(),'客户端可预览的类型必须与后端接受的一致，否则会出现「能点但取不到」');
 assert.equal(client.previewTypes.pdf,'application/pdf');
});

test('Office files are converted by the host service and streamed as PDF',async()=>{
 const calls=[];
 const office={async convert(request,signal){
  calls.push({extension:request.extension,priority:request.priority,key:request.source.key,bytes:request.source.bytes,signalAborted:Boolean(signal?.aborted)});
  const read=await request.source.read(new AbortController().signal,1024);
  assert.equal(Buffer.from(read.bytes).toString(),'DOCXBYTES','转换必须拿到受权读取的真实字节');
  assert.equal(read.version,'v1');
  return {pdf:Buffer.from('%PDF-1.7 converted'),missingFonts:['方正兰亭'],cacheKey:'ck',generation:'g1'};
 }};
 const booted=boot({bytes:Buffer.from('DOCXBYTES'),office});const server=await open(booted);
 try{
  const response=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'docs/方案.docx'}));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf','Office 必须转成 PDF 交给浏览器查看器');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(),'%PDF-1.7 converted');
  assert.equal(response.headers.get('x-office-missing-fonts'),'1','缺失字体必须如实上报');
  assert.match(decodeURIComponent(response.headers.get('x-office-missing-font-list')),/方正兰亭/);
  assert.deepEqual(calls.map(call=>[call.extension,call.priority]),[['docx','foreground']]);
  assert.match(calls[0].key,/docs\/方案\.docx$/,'缓存键必须区分具体文件');
 }finally{await server.close();booted.store.close()}
});
test('Office conversion failures are reported as conversion problems, not as missing files',async()=>{
 const office={async convert(){const error=new Error('LibreOffice 转换失败');error.name='OfficeToPdfError';throw error}};
 const booted=boot({bytes:Buffer.from('X'),office});const server=await open(booted);
 try{
  const response=await fetch(url(server.base,{workspace:'w',grantId:'g',path:'a.xlsx'}));
  assert.equal(response.status,502,'转换失败必须是 502，不能伪装成 404 文件不存在');
  assert.match(await response.text(),/LibreOffice 转换失败/);
 }finally{await server.close();booted.store.close()}
});
test('Office previews still obey grant authorization before any conversion runs',async()=>{
 let converted=0;
 const office={async convert(){converted+=1;return {pdf:Buffer.from('x'),missingFonts:[]}}};
 const booted=boot({read:false,office});const server=await open(booted);
 try{
  assert.equal((await fetch(url(server.base,{workspace:'w',grantId:'g',path:'a.docx'}))).status,403);
  assert.equal((await fetch(url(server.base,{workspace:'other',grantId:'g',path:'a.docx'}))).status,403);
  assert.equal((await fetch(url(server.base,{workspace:'w',grantId:'g',path:'../a.docx'}))).status,403);
  assert.equal(converted,0,'未授权时不得触发任何转换');
 }finally{await server.close();booted.store.close()}
});
test('client preview capability list matches what the server accepts',async()=>{
 const [server,client]=await Promise.all([import('../src/file-preview-route.mjs'),import('../prototype/preview-types.mjs')]);
 assert.deepEqual(Object.keys(client.previewTypes).sort(),[...server.previewExtensions].sort());
 assert.deepEqual(Object.keys(client.audioTypes??{}).sort(),[...server.audioExtensions??[]].sort());
 assert.deepEqual([...client.officeExtensions].sort(),[...server.officeExtensions].sort(),'Office 扩展名两侧必须一致，否则会出现「能点但取不到」');
 assert.equal(client.previewTypes.pdf,'application/pdf');
 assert.equal(server.officeMime,'application/pdf');
 for(const path of ['a.docx','b.XLSX','c.pptx'])assert(client.isOffice(path),'必须识别 Office 扩展名：'+path);
 assert(!client.isOffice('a.pdf')&&client.isPreviewable('a.pdf'));
});

test('the operator can transcribe audio inside a granted directory, and it only yields text',async()=>{
 const wav=canonicalWav();
 const {browserRoute}=await import('../src/browser-api.mjs');
 const {WorkstationStore}=await import('../src/store.mjs');
 const store=new WorkstationStore(':memory:');
 const calls=[];
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],
  files:{readBinary:async(ctx,{grantId,path})=>{calls.push({grantId,path});return {bytes:wav,size:wav.length}}},
  speech:{resolve:request=>({...request,provider:{info:{id:'sensevoice-local'}},language:'zh'}),transcribe:async()=>({text:'把试点范围跟进记为研究议题',audioSeconds:3.2,inferenceSeconds:0.9})}});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const result=await call({action:'transcribe',grantId:'voice-inbox',path:'inbox/note.wav'});
  assert.equal(result.text,'把试点范围跟进记为研究议题');
  assert.equal(result.provider,'sensevoice-local');
  assert.equal(result.grantId,'voice-inbox');
  assert.equal(result.bytes,wav.length,'必须回报真实字节数，便于核对读的是哪个文件');
  assert.deepEqual(calls,[{grantId:'voice-inbox',path:'inbox/note.wav'}]);
  // 转写不得产生任何业务写入：库里不应出现批次
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM batches').get().n,0,'转写本身不能写业务数据');
 }finally{store.close()}
});
test('transcription is refused with a real reason when the speech service is absent',async()=>{
 const {browserRoute}=await import('../src/browser-api.mjs');
 const {WorkstationStore}=await import('../src/store.mjs');
 const store=new WorkstationStore(':memory:');
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:()=>({id:'w'}),list:()=>[]},allowedWorkspaces:['w'],files:{readBinary:async()=>({bytes:new Uint8Array(),size:0})}});
 const call=async body=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...body,workspace:'w'})}));return response.json()};
 try{
  const result=await call({action:'transcribe',grantId:'voice-inbox',path:'inbox/note.wav'});
  assert.equal(result.error,'UNAVAILABLE');
  assert.match(result.message,/语音转写未接入/);
 }finally{store.close()}
});

test('录音按 Range 只送窗口，并能拖动进度条（判据 3：追回录音的那一段）', async () => {
  const audio = Buffer.alloc(5000, 7);
  const booted = boot({bytes: audio});
  const server = await open(booted);
  try {
    // 播放器拖动进度条时发的就是这种单段请求
    const ranged = await fetch(url(server.base, {workspace: 'w', grantId: 'g', path: 'voice/meeting.m4a'}), {headers: {range: 'bytes=100-199'}});
    assert.equal(ranged.status, 206, '带 Range 必须回 206');
    assert.equal(ranged.headers.get('content-type'), 'audio/mp4');
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes', '没有它浏览器就不能跳段');
    assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/5000');
    assert.equal((await ranged.arrayBuffer()).byteLength, 100, '只送请求的那一段，不整个吐出来');
    // 不带 Range：从头给一个窗口（有上限，绝不把 52MB 整个读进内存）
    const whole = await fetch(url(server.base, {workspace: 'w', grantId: 'g', path: 'voice/meeting.m4a'}));
    assert.equal(whole.status, 206);
    assert.equal((await whole.arrayBuffer()).byteLength, 5000);
    // 越界的范围要如实拒绝，不能假装成功
    const bad = await fetch(url(server.base, {workspace: 'w', grantId: 'g', path: 'voice/meeting.m4a'}), {headers: {range: 'bytes=99999-'}});
    assert.equal(bad.status, 416);
  } finally { await server.close(); booted.store.close() }
});

test('录音同样先过授权与类型检查（没有授权一个字节都不读）', async () => {
  const booted = boot({bytes: Buffer.alloc(100), read: false});
  const server = await open(booted);
  try {
    const response = await fetch(url(server.base, {workspace: 'w', grantId: 'g', path: 'voice/meeting.m4a'}), {headers: {range: 'bytes=0-9'}});
    assert.equal(response.status, 403);
  } finally { await server.close(); booted.store.close() }
});
