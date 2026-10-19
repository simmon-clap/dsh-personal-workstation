import {sharedModal} from './modal.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {downloadText} from './download.mjs';
import {previewTypes,officeExtensions,isOffice,isAudio,audioExtensions} from './preview-types.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';

/** 与其它 V7 模块一致的忙碌与错误包装：失败必须报告，不能变成未捕获拒绝。 */
const guarded=(document,notify)=>(selector,handler)=>{const node=document.querySelector(selector);if(!node)return;let pending=false;node.onclick=async()=>{if(pending)return;pending=true;node.disabled=true;try{await handler()}catch(error){notify(error.message,true)}finally{pending=false;if(node.isConnected)node.disabled=false}}};

/** V7 文件与资料：读取、编辑保存与导出授权目录内的 UTF-8 文本。 */
export const transcribeTypes=['wav','mp3','m4a','aac','flac','ogg','opus','aiff','aif','caf','amr'];
export function createFiles(document,send,{notify=()=>{},confirm=message=>globalThis.confirm(message),onArtifact,onBatch,workspace,fetchImpl=globalThis.fetch}={}){
 const modal=sharedModal(document);let token=null;
 async function openFile(initial={}){
  const request=token=modal.begin();if(request===null)return null;
  const {items}=await send('file_grants');if(!modal.current(request))return null;
  const grants=items.filter(grant=>grant.read);
  if(!grants.length){
   if(!modal.present(request,{title:'文件与资料',type:'未授权',html:'<p>当前工作区还没有任何文件目录授权，所以读不到文件。做法：打开「设置 → 能读写哪些文件夹」，给需要的文件夹点「授权只读」或「授权读写」——立即生效，不必重启，也不用改配置文件。</p><div class="modalactions"><button class="btn" id="filesclose">关闭</button></div>'}))return null;
   const closeWire=guarded(document,notify);closeWire('#filesclose',()=>modal.close());return null}
  let grantId=initial.grantId&&grants.some(grant=>grant.id===initial.grantId)?initial.grantId:grants[0].id;
  // 「跳到第几秒」要在整个打开过程中活着：从依据点进来（initial.at）之后，
  // 用户可能先看到文件列表、再点预览 —— 那个按钮的 handler 收到的是空对象，at 会丢。
  let seekAt=Number.isFinite(initial.at)&&initial.at>0?initial.at:null;
  let parts=typeof initial.path==='string'&&initial.path.includes('/')?initial.path.split('/').slice(0,-1):[];
  let currentPath=typeof initial.path==='string'?initial.path:'';
  const visible=grants.length>1?`<div class="formrow">${selectHtml({name:'grant',attribute:'data-role',label:'授权目录',value:grantId,options:grants.map(grant=>[grant.id,(grant.label||grant.id)+(grant.write?' · 可读写':' · 只读')])})}</div>`:`<p class="notice">授权目录：${esc(grants[0].label||grants[0].id)}${grants[0].write?' · 可读写':' · 只读'}</p>`;
  // 项目文件夹：项目上填了 folder 的，在这里直接列出来，点一下进那个目录。
  // 这就是"一个根目录 + 每个项目一个子文件夹"的入口（目录本身仍受授权限制）。
  // 读取失败不影响浏览：项目文件夹入口是增强，缺了它文件页仍然要能用。
  let projects=[];
  try{projects=(await send('list',{kind:'project',limit:200})).items.filter(item=>!item.archived&&item.data.folder)}catch{projects=[]}
  const projectBar=projects.length?`<div class="formrow" data-projectfolders="1"><span class="viselect-label">项目文件夹</span><div class="seg">${projects.map(item=>`<button class="btn" data-project-folder="${esc(item.data.folder)}">${esc(item.data.title)}<small style="display:block;font-size:12px;color:var(--ws-muted)">${esc(item.data.folder)}</small></button>`).join('')}</div></div>`:'';
  const html=`${projectBar}${visible}<label>目录内文件路径<input data-role="path" value="${esc(currentPath)}" placeholder="例如 notes/meeting.md"></label><div class="modalactions"><button class="btn" id="fileBrowse">浏览目录</button><button class="btn" id="filePreview">预览</button><button class="btn primary" id="fileRead">读取</button><button class="btn" id="fileTranscribe">转写录音</button></div><div id="filelisting" class="relationlist"></div><h3>语音转写结果</h3><div id="transcribebody"></div><p class="notice">转写在本机进行（首次使用会加载本地模型），只读取授权目录内的音频；其他格式（m4a / mp3 / opus 等）会在本机先转成识别器要求的 16 kHz 单声道 WAV，没有可用转换工具时会明确告诉你。文字不会自动写入业务数据，需要你点「生成一条待确认的改动」并在收件箱确认。</p><p class="notice">文本读取需为授权目录内的 UTF-8 文件；图片与 PDF 可直接预览（由浏览器渲染），其余格式不在工作台内解析。</p><div class="modalactions"><button class="btn" id="filesclose">关闭</button></div>`;
  if(!modal.present(request,{title:'文件与资料',type:'文件与资料',html}))return null;
  wireSelects(document.querySelector('#detailbody'),{document});
  const body=document.querySelector('#detailbody'),listRoot=body.querySelector('#filelisting'),pathInput=body.querySelector('[data-role="path"]');
  const grantSelect=body.querySelector('[data-role="grant"]');
  if(grantSelect)grantSelect.onchange=()=>{grantId=grantSelect.value;parts=[];listRoot.replaceChildren();notify('已切换授权目录，请重新浏览或输入路径')};
  pathInput.oninput=()=>{currentPath=pathInput.value;seekAt=null};
  // 「看原始出处」这类入口是**带着明确目标**来的（知道路径、可能还知道第几秒）：
  // 直接打开预览，而不是把人丢在文件列表上再让他自己找一遍。
  // 打不开时预览自己的错误提示会照实说话（例如超过录音大小限制），不会假装成功。
  if(initial.preview===true&&typeof initial.path==='string'&&initial.path.trim())setTimeout(()=>document.querySelector('#filePreview')?.click(),0);
  // 点项目文件夹：直接浏览那个子目录（目录本身仍受授权限制，未授权会如实报错）。
  for(const button of body.querySelectorAll('[data-project-folder]'))button.onclick=()=>{
   const folder=button.dataset.projectFolder;
   pathInput.value=folder;
   const target=folder.split('/').filter(Boolean);
   parts=target.slice(0,-1);
   browse([...target.slice(0,-1),target.at(-1)]).catch(error=>notify(error.message,true));
  };
  let browseSequence=0;
  async function browse(target=parts,offset=0){
   const sequence=++browseSequence;
   try{
    const result=await send('file_list',{grantId,path:target.join('/')||'.',offset,limit:50});
    if(!modal.current(request))return;if(sequence!==browseSequence)return;
    parts=target;listRoot.replaceChildren();
    const caption=document.createElement('p');caption.textContent='当前目录：'+(target.join('/')||'/');listRoot.append(caption);
    if(target.length){const up=document.createElement('button');up.className='btn';up.textContent='上级目录';up.onclick=()=>browse(target.slice(0,-1));listRoot.append(up)}
    for(const entry of result.items){const button=document.createElement('button');button.className='btn';button.textContent=(entry.type==='directory'?'目录 · ':'文件 · ')+entry.name;button.onclick=()=>{if(entry.type==='directory'){browse([...target,entry.name]);return}currentPath=[...target,entry.name].join('/');pathInput.value=currentPath;notify('已选择文件，请点击读取')};listRoot.append(button)}
    if(!result.items.length)listRoot.append(Object.assign(document.createElement('p'),{textContent:'此目录没有可浏览的文件'}));
    if(offset>0){const previous=document.createElement('button');previous.className='btn';previous.textContent='上一页';previous.onclick=()=>browse(target,Math.max(0,offset-50));listRoot.append(previous)}
    if(result.nextOffset!==null&&result.nextOffset!==undefined){const next=document.createElement('button');next.className='btn';next.textContent='下一页';next.onclick=()=>browse(target,result.nextOffset);listRoot.append(next)}
   }catch(error){notify(error.message,true)}
  }
  const wire=guarded(document,notify);
  wire('#filesclose',()=>modal.close());
  wire('#fileBrowse',()=>browse());
  // 语音转写（手册与 PRD：语音是四条入口之一）。操作者点击即授权；
  // 文字只用于生成草稿，写入业务数据仍要经收件箱确认。
  wire('#fileTranscribe',async()=>{
   const filePath=pathInput.value.trim(),area=body.querySelector('#transcribebody');
   const fail=message=>{if(area)area.textContent=message;notify(message,true)};
   if(!filePath){fail('请先选择或输入音频文件路径');return}
   if(!transcribeTypes.includes(filePath.toLowerCase().split('.').pop())){fail('语音转写支持的格式：'+transcribeTypes.map(item=>'.'+item).join('、'));return}
   const button=body.querySelector('#fileTranscribe');if(button)button.disabled=true;
   if(area)area.textContent='正在本机转写…首次使用需要下载模型，请稍候。';
   try{
    const result=await send('transcribe',{grantId,path:filePath});
    if(!modal.current(request))return;
    if(area)area.replaceChildren();
    const note=document.createElement('p');note.textContent=`转写完成 · ${result.provider||'本机模型'} · 音频 ${(result.audioSeconds??0).toFixed(2)} 秒 · 用时 ${(result.inferenceSeconds??0).toFixed(2)} 秒 · 来源 ${result.path}${result.converted?' · 已在本机转码（'+(result.converter||'本机工具')+'）':''}`;
    const text=document.createElement('div');text.className='proof';text.style.whiteSpace='pre-wrap';text.textContent=result.text||'（未识别到语音内容）';
    const actions=document.createElement('div');actions.className='modalactions';
    const draftButton=document.createElement('button');draftButton.className='btn primary';draftButton.dataset.transcribeDraft='1';draftButton.textContent='生成记录待确认的改动';
    draftButton.onclick=async()=>{
     draftButton.disabled=true;
     try{
      const draft=await send('draft',{title:'语音转写 · '+(result.path.split('/').pop()||'录音'),changes:[{op:'create',id:'voice-'+Date.now().toString(36),kind:'topic',data:{title:(result.text||'语音转写').slice(0,40),description:result.text??''}}],sources:{title:'语音转写（本机 '+String(result.provider||'模型')+'）',description:'录音 '+result.path}});
      if(!modal.current(request))return;
      notify('已生成一条待确认的改动，同意后写进工作台');
      onBatch?.(draft.id);
     }catch(error){notify(error.message,true)}finally{if(draftButton.isConnected)draftButton.disabled=false}
    };
    actions.append(draftButton);
    if(area)area.append(note,text,actions);
    else notify('转写完成');
   }catch(error){
    if(modal.current(request)&&area)area.textContent='转写失败：'+error.message;
    notify(error.message,true);
   }finally{if(button?.isConnected)button.disabled=false}
  });
  wire('#filePreview',async()=>{
   const filePath=pathInput.value.trim();if(!filePath)throw Error('请先选择或输入文件路径');
   const suffix=filePath.toLowerCase().split('.').pop();
   const office=isOffice(filePath);
   const audio=isAudio(filePath);
   if(!previewTypes[suffix]&&!office&&!audio)throw Error('预览只支持 '+[...Object.keys(previewTypes),...officeExtensions,...audioExtensions].map(item=>'.'+item).join('、')+'；其他格式不在工作台内解析。');
   if(!workspace)throw Error('缺少工作区上下文，无法预览');
   const source='/personal-workstation/file?'+new URLSearchParams({workspace,grantId,path:filePath});
   const request=token=modal.begin();if(request===null)return;
   // 先探一次状态：失败时给出真实原因，而不是让用户对着空白框猜。
   let probe;
   try{probe=await fetchImpl(source,{method:'GET'})}
   catch{throw Error('无法连接工作台服务（网络中断或服务未启动），无法预览该文件。')}
   if(!modal.current(request))return;
   if(!probe.ok){
    let reason='';
    try{reason=(await probe.text()).trim().slice(0,300)}catch{reason=''}
    throw Error('预览失败（HTTP '+probe.status+'）'+(reason?'：'+reason:''));
   }
   try{await probe.body?.cancel?.()}catch{}
   // Office 由宿主服务转成 PDF；服务未加载时后端返回 503，浏览器会显示为空白，这里先说清来源。
   const pdf=suffix==='pdf'||office;
   // 录音：**能跳到那一段**（宪章判据 3）。`at` 是从依据锚点 `文件@120-180` 里解析出来的起始秒数。
   // 服务端按 Range 只送窗口，所以 52MB 的会议录音也不会被整个读进内存。
   // seekAt 来自 openFile 的作用域（见上：按钮 handler 收不到 initial）
   const media=audio
    ?`<audio id="audioplayer" controls preload="metadata" src="${esc(source)}" style="width:100%"></audio>`
    :pdf
    ?`<embed type="application/pdf" src="${esc(source)}" style="width:100%;height:60vh;border:1px solid var(--line);border-radius:12px">`
    :`<img src="${esc(source)}" alt="${esc(filePath)}" style="max-width:100%;max-height:60vh;display:block;margin:0 auto;border:1px solid var(--line);border-radius:12px">`;
   const note=audio
    ?(seekAt===null
      ?'按范围读取，不把整个录音读进内存；播放器由浏览器提供，工作台不做转码。'
      :'已跳到 ' + humanSeconds(seekAt) + ' —— 这一条依据指向的就是这一段。按范围读取，不把整个录音读进内存。')
    :office
    ?'Office 文档由 DSH 的 officeToPdf 服务转换后交给浏览器查看器，工作台不解析字节；转换服务未加载或转换失败会在打开前直接给出原因。缺失字体会导致排版与原文略有改动。'
    :'字节从授权目录按只读方式读取，未做转码，渲染由浏览器完成；读取失败或类型不符会在打开前直接给出原因。';
   // 预览/读取是「文件与资料」的下一级：返回回到目录列表。
   if(!modal.present(request,{title:'预览 · '+filePath,type:'预览',html:`${media}<p class="notice" id="previewnote">${esc(note)}</p>`,onBack:()=>openFile({grantId,path:filePath,at:seekAt})}))return;
   if(audio&&seekAt!==null){
    // 跳段有两个"还没到时候"：① 弹窗内容是**异步渲染**的，present() 返回时播放器元素可能还不存在
    // （第一版就栽在这：查到时是 null，播放器就从头开始放了，实测 currentTime=5.43 而不是 8）；
    // ② 元素在但元数据没到位时，赋 currentTime 会被忽略。
    // 所以：等元素出现 → 等元数据 → 再跳。失败也不拦着人（播放器还在，能自己拖）。
    const jump=()=>{
     const player=document.querySelector('#audioplayer');
     if(!player||player.dataset.seeked==='1'||!player.isConnected)return Boolean(player);
     const seek=()=>{
      const duration=Number(player.duration);
      const note=document.querySelector('#previewnote');
      // **锚点比录音还长**时不许再声称"已跳到 N 秒"（那是在骗人：实际只会停在结尾）。
      // 真的那样就改成实话，并说明这段录音有多长。
      if(Number.isFinite(duration)&&duration>0&&seekAt>duration+0.5){
       if(note)note.textContent='这个出处写的是第 '+Math.round(seekAt)+' 秒，可这段录音只有 '+humanSeconds(duration)+' —— 已经停在录音的结尾。';
       try{player.currentTime=Math.max(0,duration-0.1)}catch{}
       player.dataset.seeked='1';
       return;
      }
      try{player.currentTime=seekAt;player.dataset.seeked='1'}catch{}
     };
     if(player.readyState>=1)seek();else player.addEventListener('loadedmetadata',seek,{once:true});
     return true;
    };
    if(!jump()){
     let tries=0;
     const timer=window.setInterval(()=>{
      tries+=1;
      if(jump()||tries>60)window.clearInterval(timer);
     },50);
    }
   }
  });
  wire('#fileRead',async()=>{
   const filePath=pathInput.value.trim();if(!filePath)throw Error('请输入文件路径');
   const file=await send('file_read',{grantId,path:filePath});
   if(!modal.current(request))return;
   await edit({grantId,path:filePath,content:file.content,version:file.version,write:grants.find(grant=>grant.id===grantId)?.write===true});
  });
  return {grants};
 }
/** 秒 → 人话："125" 写成"2 分 5 秒"（文案铁律：值要翻译给人看，不要甩数字）。 */
function humanSeconds(value){
 const total=Math.max(0,Math.round(Number(value)||0));
 const minutes=Math.floor(total/60),seconds=total%60;
 if(!minutes)return seconds+' 秒';
 if(!seconds)return minutes+' 分';
 return minutes+' 分 '+seconds+' 秒';
}
 async function edit({grantId,path,content,version,write,onSaved}){
  const request=token=modal.begin();if(request===null)return null;
  const html=`<textarea id="filetext" spellcheck="false" aria-label="文件内容" style="width:100%;height:45vh"></textarea><p id="filestate" role="status"></p><div class="modalactions">${write?'<button class="btn primary" id="filesave">保存文件</button>':''}<button class="btn" id="fileexport">导出副本</button><button class="btn" id="fileartifact">关联为资料记录</button></div><p class="notice">${write?'保存前核对版本，冲突会拒绝覆盖。':'此目录只有只读授权，不能保存回文件；要保存回请打开「空间与设置 → 目录授权」给该目录点「授权读写」（立即生效，不必重启）。'}导出只下载副本，不改动原文件。</p>`;
  if(!modal.present(request,{title:'编辑文件 · '+path,type:'文本编辑',html,beforeClose:()=>document.querySelector('#filetext')?.value===content||confirm('有未保存的修改，确定放弃并关闭？')}))return null;
  const area=document.querySelector('#filetext'),state=document.querySelector('#filestate');
  area.value=content;if(!write)area.readOnly=true;
  const update=()=>{state.textContent=(area.value===content?'内容已保存':'有未保存修改')+' · 版本 '+version};
  update();area.oninput=update;
  const wire=guarded(document,notify);
  wire('#fileexport',()=>{const name=path.split('/').pop()||'workstation.txt';downloadText(document,name.replace(/(\.[^.]+)?$/,(_,extension)=>'-副本'+(extension||'.txt')),area.value);notify('已请求下载副本；原文件未改动')});
  wire('#fileartifact',()=>onArtifact?.({path,grantId,content:area.value}));
  wire('#filesave',async()=>{
   const result=await send('file_save',{grantId,path,version,content:area.value});
   if(!modal.current(request))return;
   content=area.value;version=result.version;update();notify('已保存文件 · 版本 '+version);
   // 保存文件是真实写盘；要同步记录必须在保存成功之后再生成草稿（可预览、可撤销）。
   if(onSaved)await onSaved({grantId,path,content,version});
  });
  return {content,version};
 }
 /** 直接编辑授权目录内的某个文件：资料详情的「编辑并保存回文件」复用同一条写通道
  *  （file_read 取版本 → 文本编辑 → file_save 校验版本后写回），不新造编辑器或文件服务。 */
 async function editFile({grantId,path,onSaved}={}){
  const file=await send('file_read',{grantId,path});
  let items=[];
  try{items=(await send('file_grants')).items??[]}catch{items=[]}
  const write=items.find(grant=>grant.id===grantId)?.write===true;
  return edit({grantId,path,content:file.content,version:file.version,write,onSaved});
 }
 return {openFile,open:openFile,editFile,dispose(){modal.invalidate(token)}};
}
