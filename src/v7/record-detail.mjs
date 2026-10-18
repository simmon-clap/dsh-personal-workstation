import {whenText, spanText} from './human-time.mjs';
import {sharedModal} from './modal.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {downloadFile} from './download.mjs';
import {verifyLabel} from './knowledge-view.mjs';
import {refLabels} from './ref-labels.mjs';
import {readerHtml} from './markdown.mjs';
export const knowledgePhaseLabels={processing:'正在处理',pending:'排队中',downloading:'下载中',validating:'正在检查',ready:'已存好',failed:'失败',unknown:'无法确认','not-found':'知识库中已不存在'};
/** 知识库状态只说宿主给的事实：未存、处理中（进度）、已存好（片段数）、失败（原因）。 */
export function knowledgeStateLine(state){
 if(!state?.available)return '知识库：'+(state?.reason??'无法确认');
 if(state.status==='not-found')return '知识库：该文档已不存在（可能已被删除）';
 const label=knowledgePhaseLabels[state.status]??'无法确认';
 const detail=[];
 if(typeof state.progress==='number')detail.push('进度 '+state.progress+'%');
 if(Number.isInteger(state.chunkCount)&&state.chunkCount>0)detail.push('片段 '+state.chunkCount);
 if(state.status==='failed'&&state.message)detail.push(state.message);
 if(state.status==='unknown'&&state.rawStatus)detail.push('宿主状态 '+state.rawStatus);
 return '知识库：'+label+(detail.length?'（'+detail.join('；')+'）':'');
}
export const artifactStateLabels={current:'记录与文件一致',changed:'文件已变化，记录仍指向旧版本',missing:'文件不存在',ungranted:'没有可用的文件授权',unknown:'无法确认'};
/** 状态后面必须跟"这是什么意思、要怎么做"：原来只写「文件状态：无法确认（宿主未加载文件服务）」，
 *  像报错而不给做法（体检 A5）。标签原文保持不变，既有断言与用户已经熟悉的说法都不动。 */
export const artifactStateHints={
 current:'磁盘上的文件与记录里的版本相同。',
 changed:'磁盘上的文件被改过，记录里的内容没有跟着变。要保留新内容：点「读取文件内容」看当前文件，再用「编辑并保存回文件」保存回；要让记录也指向新版本，保存后按提示确认即可。',
 missing:'按记录里的路径找不到文件，可能被移动、改名或删除。请核对路径后编辑资料，或到「知识 → 文件与资料」重新浏览授权目录。',
 ungranted:'这个资料所在目录没有授权给工作台，所以无法核对文件。做法：打开「空间与设置 → 目录授权」，给该目录点「授权只读」或「授权读写」（立即生效，不必重启），再回到这里刷新。',
 unknown:'无法确认文件状态，通常是宿主当前读不到文件内容（例如文件服务未加载）。做法：到「空间与设置 → 接入状态」看文件服务是否加载，或稍后重试；这不代表文件有问题。'
};
/** 只报告真实比较结果：不做自动修复，也不把「旧版本」显示成一致。 */
export function artifactStateLine(state){
 const status=state?.status??'unknown';
 const label=artifactStateLabels[status]??'无法确认';
 const detail=[];
 if(state?.recordVersion)detail.push('记录版本 '+state.recordVersion);
 if(state?.currentVersion)detail.push('当前版本 '+state.currentVersion);
 if(state?.reason&&status!=='current')detail.push(state.reason);
 return '文件状态：'+label+(detail.length?'（'+detail.join('；')+'）':'')+(artifactStateHints[status]?' · '+artifactStateHints[status]:'');
}
// 能按文本读写的扩展名；其余（Office/PDF/图片/音视频）只走预览，不用文本编辑器硬读。
const textExtensions=['md','markdown','txt','csv','tsv','json','jsonl','log','yml','yaml','html','htm','css','js','mjs','cjs','ts','tsx','jsx','py','sh','xml','rst','ini','toml'];
export const textReadable=path=>{if(typeof path!=='string'||!path.trim())return false;const suffix=path.trim().toLowerCase().split('.').pop();return path.includes('.')?textExtensions.includes(suffix):true};
const contentAnchor=root=>root.querySelector('[data-content]')??root.querySelector('[data-reader]')??root.querySelector('.proof');

/** 文件类型说人话：界面不出现 text/markdown 这类 MIME（宪章七「可读」）。 */
function kindOfFile(mime='',path=''){
 const ext=String(path).toLowerCase().split('.').pop();
 const byExt={md:'Markdown 文本',markdown:'Markdown 文本',txt:'纯文本',json:'JSON 数据',csv:'表格',tsv:'表格',xlsx:'Excel 表格',xls:'Excel 表格',docx:'Word 文档',doc:'Word 文档',pptx:'PowerPoint 幻灯片',pdf:'PDF',png:'图片',jpg:'图片',jpeg:'图片',webp:'图片',gif:'图片',m4a:'录音',mp3:'录音',wav:'录音',opus:'录音'};
 if(byExt[ext])return byExt[ext];
 if(/^text\//.test(mime))return '文本';
 if(/^image\//.test(mime))return '图片';
 if(/pdf/.test(mime))return 'PDF';
 if(/word|officedocument\.word/.test(mime))return 'Word 文档';
 if(/sheet|excel/.test(mime))return '表格';
 if(/presentation/.test(mime))return '幻灯片';
 return mime||'未知类型';
}

export function createRecordDetail(document,send,{onOpenFile,onEdit,onEditFile,openCanvas,notify=()=>{},openBatch,batch}={}){
 const modal=sharedModal(document);let token=null;
 // 异步动作失败必须报告，不能变成未捕获拒绝。
 const guarded=button=>{let pending=false;const run=button.onclick;button.onclick=async()=>{if(pending)return;pending=true;button.disabled=true;try{await run()}catch(error){notify(error.message,true)}finally{pending=false;if(button.isConnected)button.disabled=false}}};
 async function open(id){const request=token=modal.begin();if(request===null)return;const {item}=await send('get',{id});if(!modal.current(request))return;if(!item||item.archived)throw Error('记录已归档或不可用，请刷新');
 const d=item.data;const type={topic:'研究议题',artifact:'文件与资料',event:'日程与事务',memoryRef:'记忆引用',judgment:'判断',person:'联系人',organization:'组织',project:'项目',task:'任务'}[item.kind]||'记录';
 // 参与人是 person ID：先解析成真实姓名（查不到如实写），再构造字段表。
 const refs=refLabels(send);
 const attendeeText=(d.attendees??[]).length?(await refs.line('person',d.attendees,'')).replace(/^：/,''):'未记录';
 // 每个对象该显示的字段：详情不能"只显示一部分"——字段传播门禁会检查（原型里有、界面看不到＝缺口）。
 // 字段相关性（2026-10-14 用户点名的类问题：「信息密，但不是无关信息的多」）：
 // 一个安排，人要决定的是「和谁、聊什么、什么时候、在哪」；外部事件 ID / 内容指纹 / 最近同步
 // 是**同步账目**，不是安排本身 —— 折进「与外部日历的同步」，默认不占版面。
 // 判据（从宪章推）：来源/编号/指纹这类账目信息只在两种情况下上屏 ——
 //   ① 它本身就是要判断的对象（判断、记忆引用，宪章第三条）；② 它处于要你处理的状态（冲突/失败）。
 const bookkeeping=[];
 const fields=item.kind==='event'?[
   ['开始',whenText(d.startDate)],['结束',whenText(d.endDate)],['地点',d.location],
   ['参与人',attendeeText],['类型',{meeting:'会议',travel:'行程',other:'其他'}[d.eventType]||d.eventType],
   // 时区只在**和本机不同**时才显示：同城安排写一遍 Asia/Shanghai 只是噪音。
   ...(d.timezone&&d.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone?[['时区',d.timezone]]:[]),
  ]:item.kind==='memoryRef'?[['来源',d.provider],['引用',d.reference],['核对来源',verifyLabel(d.verification)]]:item.kind==='artifact'?[
   ['文件路径',d.path],['文件类型',kindOfFile(d.mime,d.path)],
   ['存进知识库',d.knowledgeDocId?('已存进知识库'+(d.knowledgeUpdatedAt?'（'+String(d.knowledgeUpdatedAt).slice(0,10)+'）':'')):'还没存进知识库'],
  ]:item.kind==='judgment'?[
  ['谁能看',(d.share==='team'?'可以给同事看':'仅自己')],
   ['什么时候成立',whenText(d.validFrom)],
  ['状态',{current:'✓ 当前有效',checking:'◇ 待核对',overturned:'↩ 已被推翻'}[d.status]||d.status],
  // 来源只做**一枚小标签**（用户 2026-10-17：「最好只是 TAG，不要给信息更复杂的呈现」）。
  // 2026-10-18 D4 拍板：查不到就如实写「来源未记录」，不猜、也不藏——有就是有，没有就是没有。
  ['来源',d.origin==='ai'?'AI 起草':d.origin==='user'?'你说的':'来源未记录'],
  ['依据',Array.isArray(d.evidence)&&d.evidence.length?d.evidence.length+' 条':'缺'],
  ['不确定性',d.uncertainty||'未标不确定性'],
  ['何时复核',d.reviewBy||'未排'],
  ['推翻依据',d.overturnedBy?(String(d.overturnedBy.reason||'')+(d.overturnedBy.at?'（'+String(d.overturnedBy.at).slice(0,10)+'）':'')):''],
 ]:item.kind==='person'?[['所属组织',d.organizationId?(await refs.line('organization',[d.organizationId],'')).replace(/^：/,'')||'已删除或不可见':'未填'],['邮箱',d.email],['备注',d.note]]:item.kind==='organization'?[['网站',d.website],['主要联系人',d.contactId?(await refs.line('person',[d.contactId],'')).replace(/^：/,'')||'已删除或不可见':'未填'],['备注',d.note]]:[];
 // 账目信息（默认收起）：日程的同步账目、资料的授权与版本。
 if(item.kind==='event'){
  if(d.externalSource)bookkeeping.push(['外部来源',d.externalSource==='apple-calendar'?'苹果日历':d.externalSource]);
  if(d.externalUid)bookkeeping.push(['外部事件 ID',d.externalUid]);
  if(d.externalSyncedAt)bookkeeping.push(['最近同步',String(d.externalSyncedAt).slice(0,19).replace('T',' ')]);
  if(d.externalFingerprint)bookkeeping.push(['内容指纹',d.externalFingerprint]);
 }
 if(item.kind==='artifact'){
  if(d.fileGrantId)bookkeeping.push(['文件授权',d.fileGrantId]);
  if(d.fileVersion)bookkeeping.push(['文件版本',d.fileVersion]);
  // 知识库文档与库的 id 也是账目：字段传播门禁要求"每个字段都能被看到"，
  // 相关性判据要求"账目别占正文" —— 两边同时满足的唯一做法就是**折进账目区**：
  // 值仍然渲染在 DOM 里（门禁看得到），但默认不占版面（用户看不到）。
  if(d.knowledgeDocId)bookkeeping.push(['知识库文档',d.knowledgeDocId]);
  if(d.knowledgeBaseId)bookkeeping.push(['知识库',d.knowledgeBaseId]);
  if((d.sourceRefs??[]).length)bookkeeping.push(['来源引用',(d.sourceRefs??[]).join('、')]);
 }
 if(item.kind!=='judgment'&&item.kind!=='memoryRef'&&item.kind!=='artifact'&&(d.sourceRefs??[]).length)bookkeeping.push(['来源引用',(d.sourceRefs??[]).join('、')]);
 // 依据就地展开（VI V2 / F8）：每条依据显示出处原文与来源类型，并区分是否经第三方验证。
// 说明：批次 1 先把出处如实呈现；点击跳转到原始会话/文件/录音片段留待后续（需要引用解析）。
 const evidenceLabels={message:'会话原文',file:'文件',audio:'录音',web:'网页',note:'你的口述'};
 // 2026-10-16 补（F8）：**依据要能点回原始出处**（宪章判据 3：任何一条判断能追回录音或文件的那一段）。
 // 原来只把 `ref` 当字符串打印 —— 看得见、点不动，等于追不回去。
 // 能点回的就给按钮（同一个弹窗里钻取，不跳页）；点不回的就**如实说是哪种出处**，不摆一个点不动的按钮。
 const refKindOf=e=>{
  const ref=String(e?.ref??'').trim();
  if(!ref)return 'none';
  if(/^https?:\/\//i.test(ref))return 'web';
  if(e?.kind==='note'||/^user-said-\d+$/i.test(ref))return 'said';
  return 'record';
 };
 const evidenceBlock=item.kind==='judgment'&&Array.isArray(d.evidence)&&d.evidence.length
  ?'<h3>依据（'+d.evidence.length+' 条）</h3>'+d.evidence.map((e,index)=>{
    const ref=String(e?.ref??'').trim();
    const kind=refKindOf(e);
    const action=kind==='record'?`<button class="btn quiet" type="button" data-evidence-ref="${esc(e.ref)}">看原始出处</button>`
     :kind==='web'?`<button class="btn quiet" type="button" data-evidence-ref="${esc(e.ref)}">打开网页</button>`
     :kind==='said'?'<span class="notice">你的口述 —— 没有出处文件可点</span>'
     :'<span class="notice">这条依据没有记出处</span>';
    // 出处是**内部 id** 时不把它显示给用户（文案铁律：值要翻译，proj-xxx → 真名）；
    // id 仍留在 title 里（字段可追溯 + 排错），能点回时用按钮代替。
    const internalId=/^[A-Za-z][\w-]*$/.test(ref)&&!ref.includes('.')&&!ref.includes('/')&&!ref.includes('@');
    // 内部 id 只留在 title 里（字段可追溯 + 排错），**不在界面上给用户看**。
    const refText=!ref?'未记':internalId?'<span title="'+esc(ref)+'">这条记录</span>':esc(ref);
    // VI §8 V1 来源三态：一眼可辨这条信息是哪来的。
    // 你说的（note）= 墨色实边；原始材料（file/audio/web）= 灰底 + 引用样式；AI 推的 = 紫 + 虚线 +「AI 判断」。
    // 注意：依据的 kind 说的是**出处**（会话原文/文件/录音/网页/你的口述），不是"谁断言的"。
    // 所以这里**不能**把 message 默认成"AI 判断" —— 那是替用户说了一句我们并不知道的话（界面上说假话）。
    // 目前只有"你的口述"能确定是用户说的，其余一律按原始材料呈现；
    // AI 判断这一态用在**真正由 AI 推断**的地方（画布推断的关系、建议卡）。
    const source=e?.kind==='note'?'said':'material';
    // 来源标签是**真文字**（不是 CSS ::before 的 content）—— 否则读屏念不出来、
    // 文本断言也读不到，而 VI 明确要求"必须同时有文字"。
    const sourceText=source==='said'?'你说的':source==='material'?'原始材料':'AI 判断';
    return `<div class="proof" data-source="${source}" data-evidence="${index}"><span class="proofsource">${sourceText}</span><p>${esc(e.quote||'')}</p><p class="notice">${esc(evidenceLabels[e.kind]||'来源')}${e.verified===true?' · 已由第三方验证':e.verified===false?' · 未经第三方验证':''} · 出处 ${refText}</p>${action}</div>`;
   }).join('')
  :'';
const memoryNotice=d.verification?.status==='verified'?'核对来源只证明当时在来源中找到该内容，不保证内容仍然适用；来源变化后需重新核对来源。':d.verification?.status==='missing'?'核对来源时未在来源中找到该内容，引用可能已失效。':d.verification?.status==='unverifiable'?'本次无法核对来源（未授权、工具不可用或结果为空）；这不等于内容不存在，也不等于已验证。':'工作台引用与摘录；尚未核对来源来源记忆的当前有效性。';
 // 统一结构：先给一行摘要（类型 · 关键信息），再分小节，最后只留一个内容框。
 // 通用字段：标签与来源引用（有才显示；没有就不占位）
 // 标签对谁都有用；「来源引用」是账目 —— 只有在判断/记忆引用上它才是**要判断的东西**（宪章三），
 // 其它对象（项目/任务/日程/资料）折进账目区，不占正文。
 const provenanceIsThePoint=item.kind==='judgment'||item.kind==='memoryRef';
 const common=[...(d.tags??[]).length?[['标签',(d.tags??[]).join('、')]]:[],
  ...((d.sourceRefs??[]).length&&provenanceIsThePoint?[['来源引用',(d.sourceRefs??[]).join('、')]]:[])].filter(([,value])=>value);
 const summary=item.kind==='artifact'?[d.path?'文件：'+d.path:'未关联文件',d.mime||''].filter(Boolean).join(' · ')
  :item.kind==='memoryRef'?[d.provider?'来源：'+d.provider:'',d.reference??''].filter(Boolean).join(' · ')
  :item.kind==='event'?[spanText(d.startDate,d.endDate),d.location||'地点未设置'].join(' · ')
  :'';
 // 正文与"磁盘上现在是什么"是两件事：记录里的 content 直接读；只有路径时给出读取入口，
 // 但绝不把刚读到的文件内容假装成已经写入记录（体检 A5）。
 const contentText=(d.content??'').trim(),descriptionText=(d.description??'').trim();
 const readerSource=contentText||descriptionText;
 const canReadText=textReadable(d.path);
 const tools=item.kind==='artifact'&&d.path&&canReadText?`<button type="button" class="btn" data-readfile="1">读取文件内容</button>${onEditFile?'<button type="button" class="btn" data-writefile="1">编辑并保存回文件</button>':''}`:'';
 const readerTools=item.kind==='artifact'&&(readerSource||tools)?`<div class="readertools">${readerSource?'<button type="button" class="btn" data-readerfull="1">全屏阅读</button>':''}${tools}</div>`:'';
 const readerBody=readerSource?readerHtml(readerSource):`<div class="proof" data-empty-content="1">这条资料还没有正文内容。${d.path?(canReadText?'点「读取文件内容」把授权目录里的文本读进来（读取不会自动改写记录）。':'这个格式不能按文本读取，请用「打开文件」预览。'):'可以编辑资料补充内容或说明。'}</div>`;
 const contentBlock=item.kind==='artifact'
  ?`<section data-content="1"><h3>内容</h3><div class="reader" data-reader="1">${readerTools}<div data-mdholder="1">${readerBody}</div><p class="readernote" data-readernote="1">${readerSource?(contentText?'正文取自记录里的 content。':'正文取自记录里的说明字段。'):'记录里没有正文。'}${d.path?'磁盘上的文件可能已经不同——要按文件核对或修改，用上面的按钮。':''}</p></div></section>`
  :`<div class="proof" style="white-space:pre-wrap">${esc(readerSource||'暂无内容')}</div>`;
 const taskLine=item.kind==='artifact'?`<p data-linktasks="1">关联任务：${Array.isArray(d.taskIds)&&d.taskIds.length?d.taskIds.length+' 个':'未关联'}</p>`:'';
 const html=(summary?`<p class="notice" data-detail-summary="1">${esc(summary)}</p>`:'')
  +(()=>{const rows=[...fields,...common].filter(([,value])=>value!==undefined&&value!==null&&value!=='');
    // 只填了名称的记录以前会渲染成"基本信息"下面一片空白，看起来像坏了。
    // 如实说还没填，并指向下一步（宪章六·诚实 / VI §6 空态要有下一步）。
    if(!rows.length)return '<h3>基本信息</h3><p class="notice" data-emptyfields="1">这条记录只填了名称。用下面的「编辑'+esc(type)+'」补上其它信息。</p>';
    return '<h3>基本信息</h3>'+rows.map(([name,value])=>`<p>${name}：${esc(value)}</p>`).join('');})()+taskLine+contentBlock+evidenceBlock
  +(bookkeeping.length?`<details class="settingshelp" data-bookkeeping="1"><summary>${item.kind==='event'?'与外部日历的同步':'文件账目'}</summary>${bookkeeping.map(([name,value])=>`<p>${name}：${esc(value)}</p>`).join('')}</details>`:'')
  +(item.kind==='memoryRef'?`<p class="notice">${memoryNotice}</p>`:'');
 if(!modal.present(request,{title:d.title,type,html}))return;
 // 资料记录：加载数据库记录与文件系统的分阶段状态，读不到就如实说读不到。
 if(item.kind==='artifact')void (async()=>{
  const anchor=document.querySelector('#detailbody');if(!anchor)return;
  const block=document.createElement('div');block.dataset.artifactState='1';block.className='proof';block.textContent='文件状态：检查中…';
  anchor.insertBefore(block,contentAnchor(anchor));
  try{
   const state=await send('artifact_state',{id});
   if(!modal.current(request)||!block.isConnected)return;
   block.textContent=artifactStateLine(state);
  }catch(error){if(block.isConnected)block.textContent=artifactStateLine({status:'unknown',reason:error.message})}
 })();
 // 收录状态与入口：状态只读；收录需人工点击（点击即授权），两步结果都会如实报告。
 if(item.kind==='artifact')void (async()=>{
  const anchor=document.querySelector('#detailbody');if(!anchor)return;
  const block=document.createElement('div');block.dataset.knowledgeState='1';block.className='proof';block.textContent='知识库：正在处理…';
  // 收录按钮直接并进**同一个**动作行：既不出现第二排按钮，也不嵌套动作容器。
  const main=anchor.querySelector('.modalactions');
  const actions=document.createElement('span');actions.dataset.knowledgeActions='1';
  actions.style.cssText='display:contents';
  (main??anchor).append(actions);
  if(main)anchor.insertBefore(block,main);else anchor.append(block);
  let state=null;
  try{state=await send('knowledge_status',{id})}catch(error){state={available:false,reason:error.message}}
  if(!modal.current(request)||!block.isConnected)return;
  block.textContent=knowledgeStateLine(state);
  let bases=[];
  try{bases=(await send('knowledge_bases')).items??[]}catch{bases=[]}
  if(!modal.current(request)||!actions.isConnected)return;
  if(!bases.length){actions.textContent='没有可没有可用的知识库授权，无法存进知识库。';return}
  if(state?.available&&['processing','pending','downloading','validating','ready'].includes(state.status))return;
  const button=document.createElement('button');button.className='btn';button.type='button';button.textContent=state?.available?'重新存进知识库':'存进知识库';
  button.onclick=async()=>{
   button.disabled=true;
   try{
    const result=await send('knowledge_ingest',{id,baseId:bases[0].id});
    if(!modal.current(request))return;
    const record=(result.staged??[]).find(step=>step.stage==='record');
    notify(result.available?'已同意已存进知识库，检索在后台进行；'+(record?.note??''):'存进知识库时没完全成功：'+((result.staged??[]).find(step=>!step.ok)?.reason??'未知原因'),!result.available);
    if(record?.batchId&&openBatch)openBatch(record.batchId);
   }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
  };
  actions.append(button);
 })();
 // 关联任务：与"交付项↔任务"同一套写法——支撑几个任务、完成几个；名字读不到就如实说读不到。
 if(item.kind==='artifact'&&Array.isArray(d.taskIds)&&d.taskIds.length)void (async()=>{
  const line=document.querySelector('#detailbody [data-linktasks="1"]');if(!line)return;
  const tasks=[];
  for(const taskId of d.taskIds.slice(0,20)){
   try{const result=await send('get',{id:taskId});tasks.push({id:taskId,title:result?.item?.data?.title??null,done:result?.item?.data?.status==='done'})}
   catch{tasks.push({id:taskId,title:null,done:false})}
   if(!modal.current(request))return;
  }
  if(!line.isConnected)return;
  line.textContent='关联任务：'+tasks.filter(task=>task.done).length+'/'+tasks.length+' 已完成 · '+tasks.map(task=>task.title??('任务 '+task.id+'（名称读不到）')).join('、')+(d.taskIds.length>20?' 等':'');
 })();
 // 内嵌阅读器：目录锚点可点、可全屏（外壳 iframe 已 allow="fullscreen"）。
 const reader=document.querySelector('#detailbody [data-reader="1"]');
 const mdHolder=reader?.querySelector('[data-mdholder="1"]');
 const wireReaderParts=root=>{for(const link of root.querySelectorAll('[data-mdgoto]'))link.onclick=event=>{event.preventDefault();root.querySelector('[data-heading="'+link.dataset.mdgoto+'"]')?.scrollIntoView?.({block:'start'})}};
 if(reader)wireReaderParts(reader);
 const fullButton=reader?.querySelector('[data-readerfull]');
 if(fullButton){let full=false;fullButton.onclick=async()=>{
  try{
   if(full){await document.exitFullscreen?.();full=false}
   else if(typeof reader.requestFullscreen==='function'){await reader.requestFullscreen();full=true}
   else throw Error('当前浏览器不支持全屏阅读（可以放大浏览器窗口阅读）');
   fullButton.textContent=full?'退出全屏':'全屏阅读';
  }catch(error){notify('无法进入全屏阅读：'+error.message,true)}
 }}
 // 读取文件内容：只读到界面上，不改记录（要留档必须再走"编辑并保存回文件"）。
 const readButton=reader?.querySelector('[data-readfile]');
 if(readButton)readButton.onclick=async()=>{
  readButton.disabled=true;
  try{
   const file=await send('file_read',{grantId:d.fileGrantId,path:d.path});
   if(!modal.current(request))return;
   if(mdHolder){mdHolder.innerHTML=readerHtml(file.content);wireReaderParts(mdHolder)}
   const note=document.querySelector('#detailbody [data-readernote="1"]');
   if(note)note.textContent='现在显示的是磁盘上刚读到的内容（版本 '+file.version+'），还没有保存回记录；要留档请点「编辑并保存回文件」。';
   notify('已读取文件内容；记录未被改动');
  }catch(error){notify(error.message,true)}finally{if(readButton.isConnected)readButton.disabled=false}
 };
 // 打开材料详情时**自动读取一次**：用户说"文档应该是内嵌的"——那就不要在打开后还要多点一次。
 // 只读、不改记录；读不到（未授权/文件缺失）时保留按钮并说明原因，不静默失败。
 if(readButton&&!readerSource&&d.path&&canReadText)void (async()=>{
  try{readButton.click()}catch{/* 失败由按钮自身提示 */}
 })();
 // 图片/PDF/Office：详情里直接内嵌预览（复用受权字节路由与宿主转换，不在前端解析）
 if(item.kind==='artifact'&&d.path&&d.fileGrantId){
  const suffix=String(d.path).toLowerCase().split('.').pop();
  const images=['png','jpg','jpeg','gif','webp','svg','bmp'];
  const office=['doc','docx','xls','xlsx','ppt','pptx'];
  if(images.includes(suffix)||suffix==='pdf'||office.includes(suffix))void (async()=>{
   try{
    const workspace=(await send('runtime_status'))?.workspace?.id??'';
    const source='/personal-workstation/file?'+new URLSearchParams({workspace,grantId:d.fileGrantId,path:d.path});
    const holder=document.querySelector('#detailbody [data-mdholder="1"]');if(!holder)return;
    holder.replaceChildren();
    if(images.includes(suffix)){const img=document.createElement('img');img.src=source;img.alt=d.title??'';img.style.maxWidth='100%';holder.append(img)}
    else{const frame=document.createElement('iframe');frame.src=source;frame.title=d.title??'预览';frame.style.cssText='width:100%;height:min(70vh,640px);border:0;border-radius:10px';holder.append(frame)}
    const note=document.querySelector('#detailbody [data-readernote="1"]');
    if(note)note.textContent=office.includes(suffix)?'Office 由宿主转换成 PDF 后在这里内嵌显示（工作台不解析文档内容）。':'直接内嵌显示受权目录里的原文件。';
   }catch(error){notify('内嵌预览失败：'+error.message,true)}
  })();
 }
 // 编辑并保存回文件：复用既有受权写通道（file_read 取版本 → file_save 校验版本后写回）；
 // 只读目录明确拒绝，并指明去「空间与设置 → 目录授权」点"授权读写"（立即生效、不必重启）。
 const writeButton=reader?.querySelector('[data-writefile]');
 if(writeButton)writeButton.onclick=async()=>{
  writeButton.disabled=true;
  try{
   if(!onEditFile)throw Error('保存回文件的入口未接入');
   let items=[];
   try{items=(await send('file_grants')).items??[]}catch{items=[]}
   const grant=items.find(entry=>entry.id===d.fileGrantId);
   if(grant&&!grant.write)throw Error('目录「'+(grant.label||grant.id)+'」只有只读授权，不能保存回文件。');
   await onEditFile({grantId:d.fileGrantId,path:d.path,onSaved:async saved=>{
    const draft=await send('draft',{title:'按文件更新资料 · '+(d.title??item.id),changes:[{op:'update',id:item.id,expectedRevision:item.revision,data:{...d,content:saved.content,fileVersion:saved.version}}],sources:{content:'用户在资料详情按文件内容保存',fileVersion:'保存文件后读回的新版本'}});
    if(!modal.current(request))return;
    notify('已保存文件 · 版本 '+saved.version+'；已生成待你确认的改动，同意后才更新记录');
    openBatch?.(draft.id);
   }});
  }catch(error){
   const hint=/授权|许可|FORBIDDEN|只读/.test(error.message)?'做法：打开「空间与设置 → 目录授权」给该目录点「授权读写」（立即生效，不必重启），再回来重试。':'';
   notify(error.message+(hint?' · '+hint:''),true);
  }finally{if(writeButton.isConnected)writeButton.disabled=false}
 };
 const body=document.querySelector('#detailbody'),editable={topic:'topic',artifact:'artifact',event:'event',memoryRef:'memoryRef',organization:'organization',person:'person',judgment:'judgment'};
 const actions=document.createElement('div');actions.className='modalactions';
 // 日程的导出放到最后：它是低频动作，不该占主操作位（主操作是「编辑」）。
 const eventExport=()=>{const button=document.createElement('button');button.className='btn';button.id='eventics';button.textContent='导出 ICS';
  button.onclick=async()=>{const file=await send('calendar_export',{ids:[item.id]});if(modal.current(request))downloadFile(document,file)};
  guarded(button);return button};
 // 记忆引用：用户可以直接登记核验结果。**你自己点的，就直接生效 + 左下可撤销**（契约②）。
 // 原来这里生成一条待确认的改动丢进收件箱 —— 等于让你对自己刚做的决定再点一次头；
 // 独立走查把它记成 F13 ③：「同一件事要你点两次头」。
 if(item.kind==='memoryRef'){
  const options=[['verified','标记为已核对来源'],['missing','标记为来源中未找到'],['unverifiable','标记为无法核对来源']];
  for(const [status,label] of options){
   if(item.data.verification?.status===status)continue;
   const button=document.createElement('button');button.className='btn';button.dataset.verify=status;button.textContent=label;
   button.onclick=async()=>{
    button.disabled=true;
    try{
     const nextVerification={status,checkedAt:new Date().toISOString(),note:'由用户在界面确认'};
     const patch={...item.data,verification:nextVerification};
     if(typeof batch?.apply==='function'){
      await batch.apply('核对来源：'+(item.data.title??item.id),[{op:'update',id:item.id,expectedRevision:item.revision,data:patch}]);
      notify(label.replace('标记为','已标记为'));
      modal.close();
     }else{
      const draft=await send('draft',{title:'核对来源记忆引用 · '+(item.data.title??item.id),changes:[{op:'update',id:item.id,expectedRevision:item.revision,data:patch}]});
      if(!modal.current(request))return;
      notify('已生成待确认的核对结果，同意后写进工作台');
      openBatch?.(draft.id);
     }
    }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
   };
   actions.append(button);
  }
 }
 // 资料最常做的是"在详情里读"：主按钮＝内嵌阅读（文本 markdown / 图片 / PDF / Office），
 // 「打开文件与资料」降为次操作——原来主按钮直接跳文件浏览器，用户会以为"没有内嵌打开"。
 // 分享边界（F17）：一键切换，走 batch.apply 直接生效可撤销。默认「仅自己」。
 if(item.kind==='judgment'){
  const button=document.createElement('button');button.className='btn';button.id='judgmentshare';button.dataset.share=d.share==='team'?'team':'private';
  button.textContent=d.share==='team'?'已标：可以给同事看':'已标：仅自己';
  button.onclick=async()=>{
   const next=button.dataset.share==='team'?'private':'team';
   button.disabled=true;
   try{
    await (typeof batch?.apply==='function'?batch.apply:batch?.draft)('谁能看 · '+(d.title??item.id),[{op:'update',id:item.id,expectedRevision:item.revision,data:{...d,share:next}}]);
    if(!modal.current(request))return;
    button.dataset.share=next;button.textContent=next==='team'?'已标：可以给同事看':'已标：仅自己';
    notify(next==='team'?'这条可以给同事看（导出时会包含它）':'已改回仅自己（导出时会剔除它）');
   }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
  };
  actions.append(button);
 }
 // 判断核对（03 F7）：核对后不写「已核对」了事，而是把不确定性说明**改写成你实际核到的情况**。
 // 走 batch.apply —— 这是你自己发起的操作，按契约直接生效、左下可撤销，不再追问一次。
 if(item.kind==='judgment'&&d.status==='checking'){
  const row=document.createElement('div');row.className='formfield';row.dataset.judgmentVerify='1';
  const label=document.createElement('span');label.textContent='核到你实际看到的情况';
  const input=document.createElement('textarea');input.id='judgmentverify';input.dataset.field='uncertainty';
  input.placeholder='例如：已与对方确认，指标口径为 FP8 实测';input.value=d.uncertainty??'';
  const hint=document.createElement('p');hint.className='formhint';hint.textContent='留空表示"已核对，没有不确定的部分"。核对完状态会从「待核对」变成「当前有效」。';
  row.append(label,input,hint);
  // actions 在这一步可能还没插进 DOM，before() 会静默失败 —— 带回退
  if(actions.isConnected)actions.before(row);else (document.querySelector('#detailbody')??document.body).append(row);
  const button=document.createElement('button');button.className='btn primary';button.id='judgmentverifyapply';button.textContent='核对完成';
  button.onclick=async()=>{
   const text=input.value.trim();
   if(text.length>300){notify('不确定性说明最多 300 字，请精简后再保存',true);return}
   button.disabled=true;
   try{
    const next={...d,status:'current',uncertainty:text};
    await (typeof batch?.apply==='function'?batch.apply:batch?.draft)('核对完成 · '+(d.title??item.id),[{op:'update',id:item.id,expectedRevision:item.revision,data:next}]);
    if(!modal.current(request))return;
    notify('已核对，状态改为「当前有效」');
    // 就地更新，不跳页（交互律 06）：改状态文字、收起核对区
    const statusNode=[...document.querySelectorAll('#detailbody p')].find(node=>node.textContent.startsWith('状态：'));
    if(statusNode)statusNode.textContent='状态：当前有效';
    row.remove();button.remove();
   }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
  };
  actions.append(button);
 }
 if(item.kind==='artifact'){const button=document.createElement('button');button.className='btn primary';button.id='recordreadinline';button.textContent='在详情里阅读';button.onclick=async()=>{
  button.disabled=true;
  try{
   const holder=document.querySelector('#detailbody [data-reader]');
   if(holder)holder.scrollIntoView({block:'nearest'});
   const trigger=document.querySelector('#detailbody [data-readfile="1"]')??document.querySelector('#detailbody [data-read="1"]');
   if(trigger)trigger.click();else notify('这条资料没有可读的文件或正文',true);
  }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
 };actions.append(button)}
 if(item.kind==='artifact'&&onOpenFile&&d.path){const button=document.createElement('button');button.className='btn';button.id='recordopenfile';button.textContent='打开文件与资料';button.onclick=()=>onOpenFile({grantId:d.fileGrantId,path:d.path});actions.append(button)}
 // F8：依据的「看原始出处」—— 同一个弹窗里钻取（零跳页）。
 // 出处是资料且带文件 → 直接打开那个文件（"追回录音或文件的那一段"）；否则打开那条记录；
 // 都打不开就**如实说找不到**，不假装跳过去了。
 for(const button of document.querySelectorAll('#detailbody [data-evidence-ref]')){
  const ref=button.dataset.evidenceRef;
  button.onclick=async()=>{
   if(/^https?:\/\//i.test(ref)){window.open(ref,'_blank','noopener');return}
   // 锚点可能带范围（`a-rec@120-180`）。**左半段既可能是对象 id、也可能是文件名** ——
   // 原来只拿整个 ref 去 get，带范围的 id 一定查不到，于是掉到"按文件名找"那条路，
   // 而依据里存的 id 不是文件名，最后只能说"找不到了"。
   // 实测就是这个问题：点「看原始出处」什么都不发生（判据 3 的最后一层断在这）。
   const ranged=/^(.+?)@(\d+)-(\d+)$/.exec(ref);
   const idPart=ranged?ranged[1]:ref;
   const at=ranged?Number(ranged[2]):null;
   const withAt=options=>Number.isFinite(at)&&at>0?{...options,at}:options;
   let target=null;
   try{({item:target}=await send('get',{id:idPart}))}catch{}
   if(target&&!target.archived){
    if(target.kind==='artifact'&&target.data?.path&&onOpenFile){
     // 带范围（规范 03 §10：录音 → 文件 + 时间区间（秒））→ 把起始秒数带下去，
     // 录音打开时**直接跳到那一段**（判据 3 的最后一层）。
     onOpenFile(withAt({grantId:target.data.fileGrantId,path:target.data.path,preview:true}));
     return}
    await open(ref);return;
   }
   // 出处的另一种真实形状是「文件@时间段」（spec/03 §10 的引用锚点：录音 → 文件 + 时间区间）。
   // 按文件名找同名资料；找得到就打开那个文件（"追回录音或文件的那一段"）。
   const fileRef=idPart;
   let items=[];
   try{({items}=await send('list',{kind:'artifact',limit:200}))}catch{}
   const hit=(items??[]).find(candidate=>!candidate.archived&&candidate.data?.path
    &&(candidate.data.path===fileRef||candidate.data.path.endsWith('/'+fileRef)||candidate.data.path.split('/').pop()===fileRef));
   if(hit&&onOpenFile){onOpenFile(withAt({grantId:hit.data.fileGrantId,path:hit.data.path,preview:true}));return}
   notify('这条出处已经找不到了：'+ref,true);
  };
  guarded(button);
 }
 if(editable[item.kind]&&onEdit){const button=document.createElement('button');button.className='btn'+(item.kind==='artifact'?'':' primary');button.textContent='编辑'+type;button.onclick=()=>onEdit(item.kind,item);actions.append(button)}
 if(openCanvas){const button=document.createElement('button');button.className='btn';button.id='recordcanvas';button.textContent='在画布中查看关联';button.onclick=()=>openCanvas(item.id);actions.append(button)}
 if(item.kind==='event'){actions.append(eventExport());actions.append(Object.assign(document.createElement('small'),{textContent:'导出只包含已保存的日程；不发送邀请。'}))}
 body.append(actions);
 return item;
 }
 return {open,dispose(){modal.invalidate(token)}};
}
