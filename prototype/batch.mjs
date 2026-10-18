import {sharedModal} from './modal.mjs';
import {humanTitle} from './human-title.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';

/** 授权目录清单（由 createBatchFlow 用真实数据填充；默认空）。 */
let directoryGrants=[];
const opNames={create:'新建',update:'修改',archive:'归档',restore:'恢复',delete:'删除'};
// 归属行只给「材料」（资料记录 / artifact）看：体检报告 A2 说的材料就是它。
// 研究议题、任务、日程、记忆引用的归属由 Agent/界面显式写 projectId，不在预览里替用户判定。
const projectKinds=new Set(['artifact']);
/** 字段中文标签：差异卡与来源说明都不许泄漏 title/path/fileGrantId 这类英文键（体检 A1）。
 *  覆盖 src/validation.mjs 允许的全部字段；将来新增字段若忘了登记，测试会红——不靠自觉。 */
export const fieldLabels={title:'标题',description:'说明',tags:'标签',projectId:'所属项目',sourceRefs:'来源引用',goal:'目标 / 预期成果',partnerId:'合作机构',ownerId:'负责人',stage:'阶段',startDate:'开始日期',dueDate:'截止日期',deliverables:'交付项',folder:'项目文件夹',stageHistory:'阶段记录',status:'状态',steps:'步骤',dependsOn:'依赖任务',executionTarget:'执行端',blockedReason:'等待原因',expectedOutput:'预期成果',deliverableId:'所属交付项',website:'网站',organizationId:'所属组织',email:'邮箱',content:'内容',path:'关联文件路径',fileGrantId:'授权目录',mime:'文件类型',fileVersion:'文件版本',taskIds:'关联任务',knowledgeBaseId:'知识库',knowledgeDocId:'知识库文档',knowledgeUpdatedAt:'知识库存入时间',endDate:'结束日期',timezone:'时区',location:'地点',attendees:'参与人',eventType:'事务类型',from:'关系起点',to:'关系终点',evidence:'关联证据',reason:'推断理由',basis:'确认依据',positions:'坐标',viewport:'视口',provider:'来源提供方',reference:'记忆引用标识',verification:'核对来源结果',source:'来源',sourceUrl:'来源链接',publishedAt:'发布时间',fetchedAt:'登记时间',linkStatus:'链接状态',uncertainty:'不确定性',importance:'重要程度',urgency:'紧急程度',groups:'画布分组',externalSource:'外部来源',externalUid:'外部事件编号',externalSyncedAt:'外部同步时间',externalFingerprint:'外部内容指纹',validFrom:'什么时候成立',reviewBy:'何时复核',overturnedBy:'推翻依据',share:'谁能看',origin:'来源'};
export const fieldLabel=key=>fieldLabels[key]??('未命名的内容项（'+key+'）');

/** 字段值转成可读文本：空值写「（无）」；结构化字段（交付项/坐标…）按原值展示，不猜语义。 */
export function formatValue(value){
 if(value===undefined||value===null)return '（无）';
 if(typeof value==='string')return value.trim()?value:'（无）';
 if(typeof value==='number'||typeof value==='boolean')return String(value);
 try{return JSON.stringify(value)}catch{return '（无法显示）'}
}

const clampLines=3,clampChars=300;
/** 长文本默认只给前 3 行：会议纪要这种必须能读，但不能一屏全是它。 */
export function clampValue(text){
 const value=String(text??'');
 const lines=value.split('\n');
 if(lines.length<=clampLines&&value.length<=clampChars)return {text:value,clamped:false};
 let head=lines.slice(0,clampLines).join('\n');
 if(head.length>clampChars)head=head.slice(0,clampChars);
 return {text:head+'…',clamped:true};
}

/** 中文差异行：每行「名称：旧值 → 新值」。
 *  归档与删除没有字段级差异——只如实说明状态怎么变，不假装其它字段也跟着变了。 */
export function diffRows(entry){
 const before=entry.before?.data??null,after=entry.after??null;
 if(entry.op==='archive'||entry.op==='delete')return [{key:null,name:'状态',from:before?.status??null,to:entry.op==='archive'?'已归档':'已删除'}];
 const source=after??{};
 return Object.keys(source).filter(key=>JSON.stringify(source[key])!==JSON.stringify(before?.[key])).map(key=>({key,name:fieldLabel(key),from:before?before[key]:null,to:source[key]}));
}

/** 逐字段来源：只显示确实标注过的字段，其余明确写「未标注来源」，不替模型编出处。 */
export function fieldSources(entry){
 const after=entry.after??{},before=entry.before?.data??{};
 const changed=Object.keys(after).filter(key=>JSON.stringify(after[key])!==JSON.stringify(before[key]));
 if(!changed.length)return '';
 const sources=entry.sources??{};
 const items=changed.map(key=>`${fieldLabel(key)}：${sources[key]?sources[key]:'未标注来源'}`);
 const annotated=changed.filter(key=>sources[key]).length;
 return `<div class="proof" data-sources="1">字段来源（${annotated}/${changed.length} 已标注）<br>${items.map(item=>esc(item)).join('<br>')}</div>`;
}

/** V7 centred dialog for the versioned batch lifecycle: preview, commit, receipt and undo. */
export function createBatchFlow(document,send,{onCommitted=()=>{},notify=()=>{},confirm=message=>globalThis.confirm(message)}={}){
 const modal=sharedModal(document);let token=null,dirty=false;
 // 项目名只为把「归属：X 项目」写成人看得懂的名字；读不到就退回项目 id，不编名字。
 const projectTitles=new Map();let projectsRequested=false,projectsUnavailable=false;
 async function loadProjects(){
  if(projectsRequested)return;
  projectsRequested=true;
  try{
   const {items}=await send('list',{kind:'project',limit:1000});
   for(const item of items??[])if(item&&!item.archived)projectTitles.set(item.id,item.data?.title??item.id);
  }catch{projectsUnavailable=true/* 读不到项目名不影响预览：下面会如实显示项目 id */}
 }
 const wireNode=(node,run)=>{if(!node)return;let pending=false;node.onclick=async()=>{if(pending)return;pending=true;node.disabled=true;node.setAttribute('aria-busy','true');try{await run()}catch(error){notify(error.message,true)}finally{pending=false;if(node.isConnected){node.disabled=false;node.removeAttribute('aria-busy')}}}};
 const wire=(selector,run)=>wireNode(document.querySelector(selector),run);
 function present(request,batch,excluded,stale){
  // 报错只说人话：不再把 {"code":"INVALID",...} 甩给用户；缺依据这类能就地修，就给修复入口。
  const plainProblem=error=>{
   const text=typeof error==='string'?error:(error?.message??'');
   if(/依据|文本证据/.test(text))return {kind:'evidence',text:'这条关联还缺一句依据：写清为什么把它们连在一起'};
   if(/过期|版本/.test(text))return {kind:'stale',text:'这个对象在你确认前被改过，需要看最新内容再决定'};
   if(/不可用|不存在/.test(text))return {kind:'reference',text:'它引用的对象不存在或已归档，需要换一个'};
   return {kind:'other',text:text||'这条改动现在还保存不了'};
  };
  const problemList=[...(batch.validationErrors??[]).map(plainProblem),...(batch.conflicts??[]).map(item=>({kind:'stale',text:'这个对象在你确认前被改过'}))];
  const problems=problemList.map(problem=>problem.text);
  // 缺依据不算卡住：弹窗里就有输入框可以就地补；其余问题才是真的不能保存。
  const blocking=problemList.filter(problem=>problem.kind!=='evidence');
  const editable=batch.status==='draft'&&!blocking.length;
  // 长文本全文放在闭包里而不是 data-* 属性：属性会被读屏当成内容播报，长文塞属性也不合适。
  const longTexts=[];
  const valueHtml=(value,side)=>{
   const text=formatValue(value),clamped=clampValue(text);
   if(!clamped.clamped)return `<span class="diffvalue" data-side="${side}">${esc(clamped.text)}</span>`;
   const position=longTexts.push(text)-1;
   return `<span class="diffvalue" data-side="${side}" data-clamped="1">${esc(clamped.text)}</span><button type="button" class="btn difftoggle" data-expand="${position}">展开全文</button>`;
  };
  const fieldHtml=rows=>rows.map(row=>`<div class="diffrow" ${row.key?`data-field="${esc(row.key)}"`:'data-summary="1"'}><b class="diffname">${esc(row.name)}</b>：${valueHtml(row.from,'old')} → ${valueHtml(row.to,'new')}</div>`).join('');
  // 人话描述：用户看不懂"改动"，只看懂"要做什么"。每条改动一句话 + 勾选框。
  // 值也要翻译：不能把 high / text/markdown / dir-xxx / proj-xxx 这种内部值端给用户。
  const kindNames={project:'项目',task:'任务',artifact:'材料',topic:'议题',event:'日程',memoryRef:'记忆引用',organization:'组织',person:'联系人',relation:'关联',brief:'简报',judgment:'判断'};
  const levelNames={high:'高',medium:'中',low:'低'};
  const mimeNames={'text/markdown':'Markdown 文档','text/plain':'文本','application/pdf':'PDF','application/json':'JSON'};
// 授权目录的名字：能读到就用真名，读不到就说「已指定授权目录」——绝不把 dir-xxxx 端给用户。
  const grantNames=new Map((typeof directoryGrants!=='undefined'?directoryGrants:[]).map(grant=>[grant.id,grant.label||grant.id]));
  const idFields=new Set(['projectId','ownerId','partnerId','organizationId','deliverableId','fileGrantId','knowledgeBaseId','knowledgeDocId']);
  const plainValue=(key,value)=>{
   if(value===undefined||value===null||value==='')return '清空';
   if(['importance','urgency'].includes(key))return levelNames[value]??String(value);
   if(key==='fileGrantId')return grantNames.get(value)?`「${grantNames.get(value)}」`:'已指定';
   if(key==='projectId'){const info=projectInfo(value);return info?`「${info.title}」`:'已指定'}
   if(idFields.has(key))return '已指定';
   if(key==='mime')return mimeNames[value]??String(value);
   if(Array.isArray(value))return value.length?`${value.length} 项`:'清空';
   if(typeof value==='object')return '已设置';
   const text=String(value);
   if(text.length>24)return `（${text.length} 字的正文）`;
   return text;
  };
  const describeChange=(entry,index)=>{
   const after=entry.after??{};
   const before=entry.before??{};
   const name=after.title??before.title??entry.id;
   // 类型名优先取这批改动里的 kind（diff 条目本身不带 kind），不能一律叫「记录」
   const kind=kindNames[entry.kind??batch.changes?.[index]?.kind]??entry.kind??'记录';
   const projectName=id=>{if(!id)return '';const info=projectInfo(id);return info?`「${info.title}」`:''};
   if(entry.op==='create'){
    const tail=[];
    if(after.projectId)tail.push('属于项目'+projectName(after.projectId));
    if(after.startDate)tail.push(String(after.startDate).slice(0,16).replace('T',' '));
    return `新建${kind}「${name}」${tail.length?'（'+tail.join(' · ')+'）':''}`;
   }
   if(entry.op==='archive')return `归档${kind}「${name}」`;
   if(entry.op==='restore')return `恢复${kind}「${name}」`;
   if(entry.op==='delete')return `删除${kind}「${name}」`;
   // update：只列真正变了的字段，用中文标签说清楚从什么改成什么
   const changed=[];
   for(const key of Object.keys(after)){
    const label=fieldLabels[key];if(!label)continue;
    const from=before[key],to=after[key];
    if(JSON.stringify(from??null)===JSON.stringify(to??null))continue;
    // 只有真正"改了值"才说 →；新增字段说"补上"
    changed.push(from===undefined||from===''||from===null?`补上${label} ${plainValue(key,to)}`:`${label} 改成 ${plainValue(key,to)}`);
   }
   const target=typeof entry.id==='string'&&entry.id.startsWith('rel-')?'关联':kind;
   if(!changed.length)return `修改${target}「${name}」（内容与原来一致）`;
   return `修改${target}「${name}」：${changed.slice(0,4).join('、')}${changed.length>4?` 等 ${changed.length} 项`:''}`;
  };
  const opVerb={create:'新建',update:'修改',archive:'归档',restore:'恢复',delete:'删除'};
  const rows=batch.diff.map((entry,index)=>{
   const fields=fieldHtml(diffRows(entry));
   const kept=!excluded.has(index);
   const human=describeChange(entry,index);
   return `<section class="diff" data-change="${index}" data-kept="${kept?'1':'0'}">
     <label class="diffpick"><input type="checkbox" data-keep="${index}" ${batch.status==='draft'?'':'disabled'} ${kept?'checked':''}><span class="diffhuman">${esc(human)}</span></label>
     ${(entry.op==='create'&&batch.changes?.[index]?.kind==='relation'&&!batch.changes?.[index]?.data?.evidence)?`<div class="diffrow" data-needsevidence="${index}"><label class="field"><span>这句依据（必填，之后能回看）</span><input type="text" data-evidence="${index}" placeholder="为什么把它们连在一起"></label><button class="btn" type="button" data-fixevidence="${index}">补上依据</button></div>`:''}
     <details class="diffdetail"><summary>看字段明细</summary>${fields||'<div class="diffrow" data-field-none="1"><span class="diffvalue">这项改动没有字段改动。</span></div>'}${fieldSources(entry)}</details>
   </section>`;
  }).join('');
  // 归属核对：自动关联必须看得见、改得动。不认可自动补的归属，可以在**这一批草稿里**改回未归属或换项目。
  // 用函数声明（会提升）：上面的人话描述器在 rows 生成时就要用它，写成 const 会踩 TDZ。
  function projectInfo(id){
   const created=(batch.diff??[]).find(item=>item.id===id&&item.op==='create'&&item.after&&item.after.title);
   if(created)return {title:created.after.title,created:true};
   if(projectTitles.has(id))return {title:projectTitles.get(id),created:false};
   // 读不到项目清单时不假装知道它是谁；读到了却查无此项目就说清，用户才知道提交会被引用校验拦下。
   return {title:'项目 '+id+(projectsUnavailable?'':'（不在项目列表中）'),created:false};
  };
  const linkRows=(batch.diff??[]).map((entry,index)=>{
   if(entry.op==='archive'||entry.op==='delete')return null;
   const change=batch.changes?.[index]??null;
   const kind=change?.kind??entry.before?.kind??null;
   if(!kind||!projectKinds.has(kind))return null;
   const data=entry.after??entry.before?.data??null;
   if(!data)return null;
   const source=entry.sources?.projectId??'';
   return {index,op:entry.op,title:data.title??entry.id,projectId:data.projectId??null,auto:/自动关联/.test(source)};
  }).filter(Boolean);
  // 本批新建的项目必须出现在候选里：同批两个新建项目时服务端不猜，由用户在这里一次指定。
  const projectOptions=[...projectTitles];
  for(const item of batch.diff??[])if(item.op==='create'&&item.after&&!projectTitles.has(item.id))projectOptions.push([item.id,item.after.title??item.id]);
  const linkBlock=linkRows.length?`<div class="proof" data-linkblock="1">归属核对（${linkRows.length} 条）<br>${linkRows.map(row=>{
   const assigned=Boolean(row.projectId);
   const info=assigned?projectInfo(row.projectId):null;
   // 自动补的归属由机器写成「同批新建项目自动关联」，不粉饰成用户或 Agent 的判断。
   const note=assigned?(row.auto?'（本批新建项目自动关联）':info.created?'（本批新建）':''):'';
   const text=assigned?(row.op==='create'?'将归属：':'归属：')+esc(info?info.title:'')+note:'归属：未归属';
   let control='';
   if(editable)control=assigned?`<button type="button" class="btn" data-unlink="${row.index}">改为未归属</button>`
    :projectOptions.length?`${selectHtml({name:String(row.index),attribute:'data-linkpick',value:'',options:[['','选择项目'],...projectOptions],placeholder:'选择项目',id:'linkpick-'+row.index})}<button type="button" class="btn" data-link="${row.index}">指定项目</button>`
    :'<span class="notice">没有可指定的项目：请先建项目，再回到这批指定。</span>';
   return `${esc(row.title)} —— ${text}${control?'　'+control:''}`;
  }).join('<br>')}</div>`:'';
  // 删除类变更：先把"会影响谁"摆出来，再让用户决定（服务端提交时还会再拦一次）。
  const deletions=(batch.diff??[]).filter(entry=>entry.op==='delete');
  const references=batch.references??[];
  const referenceBlock=deletions.length?`<div class="proof" data-delete-impact="1">${references.length?`删除前请先处理引用：<br>${references.slice(0,8).map(ref=>esc(ref.targetTitle)+' ← '+esc(ref.title)+'（'+esc(ref.field)+'）').join('<br>')}${references.length>8?'<br>…共 '+references.length+' 处':''}`:'这些对象没有被其它记录引用，可以删除。删除后仍可撤销。'}</div>`:'';
const keptCount=batch.diff.filter((_,index)=>!excluded.has(index)).length;
 const draftIntro=batch.status==='draft'
  ? `<p class="notice" data-inbox-intro="1">这是<strong>还没生效</strong>的改动：同意后才会写进工作台，不同意就一点都不改。你可以只同意其中几项。</p>`
  : `<p class="notice" data-inbox-intro="1">这批改动已经处理过（状态：${esc(batch.status)}）。</p>`;
 const html=`${draftIntro}${stale?'<p class="notice" data-stale="1">取舍改过了，请重新确认一次再点同意。</p>':''}${referenceBlock}${problems.length?`<div class="proof">${problems.map(problem=>esc(problem)).join('<br>')}</div>`:''}${linkBlock}<div id="batchdiff">${rows||'<p>此待确认的改动没有变更项。</p>'}</div><div class="modalactions"><button class="btn primary" id="batchCommit" ${editable&&!stale?'':'disabled'}>${keptCount===batch.diff.length?`全部同意（${keptCount} 项）`:`同意所选（${keptCount} 项）`}</button><button class="btn" id="batchCancel" ${batch.status==='draft'?'':'disabled'}>全部不同意</button><button class="btn" id="batchLater" type="button">稍后再决定</button></div>`;
  dirty=false;
  if(!modal.present(request,{title:humanTitle(batch.title)||'确认这次改动',type:'确认这次改动',html,beforeClose:()=>!dirty||confirm('取舍尚未重新预览，确定放弃并关闭？')}))return false;
  // 来源指令：读取服务端记录的来源会话原文（只取用户消息），失败就如实说读不到。
  void (async()=>{
   try{
    const origin=await send('batch_origin',{id:batch.id});
    if(!modal.current(request))return;
    const body=document.querySelector('#detailbody');if(!body)return;
    const node=document.createElement('div');node.className='proof';node.dataset.origin='1';
    node.textContent=origin.available
     ? `来源会话：${origin.title||origin.sessionId}${origin.count>origin.messages.length?`（共 ${origin.count} 条指令，显示最近 ${origin.messages.length} 条）`:''}\n\n`+origin.messages.map(message=>message.text).join('\n---\n')
     : `来源：${origin.reason}`;
    const anchor=body.querySelector('#batchdiff');
    body.insertBefore(node,anchor??body.firstChild);
   }catch(error){notify('无法读取来源指令：'+error.message,true)}
  })();
  const body=document.querySelector('#detailbody');
  wireSelects(body,{document});
  for(const node of body.querySelectorAll('[data-expand]'))node.onclick=()=>{
   const full=longTexts[+node.dataset.expand],value=node.previousElementSibling;
   if(full===undefined||!value)return;
   value.textContent=full;value.removeAttribute('data-clamped');node.remove();
  };
  // 勾选只影响"同意哪些"：取消勾选不会立刻改草稿，点「同意所选」时才把选择落到草稿上。
  for(const input of body.querySelectorAll('[data-keep]'))input.onchange=()=>{
   if(input.checked)excluded.delete(+input.dataset.keep);else excluded.add(+input.dataset.keep);
   const section=input.closest('[data-change]');if(section)section.dataset.kept=input.checked?'1':'0';
   const kept=batch.diff.filter((_,index)=>!excluded.has(index)).length;
   const commitButton=document.querySelector('#detailbody #batchCommit');
   if(commitButton){commitButton.textContent=(kept===batch.diff.length?`全部同意（${kept} 项）`:`同意所选（${kept} 项）`);commitButton.disabled=kept===0}
  };
  // 改归属 = 修订同一批草稿（revision+1），不绕过批次直接写数据；提交前仍可再改。
  async function revise(index,update){
   if(batch.status!=='draft')throw Error('只有待确认的改动能改归属');
   const changes=batch.changes.map((change,position)=>position===index?update(change):change);
   const updated=await send('draft',{id:batch.id,revision:batch.revision,title:batch.title,changes});
   if(!modal.current(request))return;
   await review(updated.id);
  }
  for(const node of body.querySelectorAll('[data-link]'))wireNode(node,async()=>{
   const index=+node.dataset.link;
   const picked=body.querySelector('[data-linkpick="'+index+'"]');
   const value=picked?.value??'';
   if(!value)throw Error('请先选择要归属的项目，再点「指定项目」');
   await revise(index,change=>({...change,data:{...change.data,projectId:value},sources:{...(change.sources??{}),projectId:'用户在预览中指定'}}));
  });
  for(const node of body.querySelectorAll('[data-unlink]'))wireNode(node,async()=>{
   const index=+node.dataset.unlink;
   await revise(index,change=>{
    // 去掉归属时也必须去掉它的来源标注：sources 只能标注本次 data 里真实存在的字段。
    const {projectId,...data}=change.data;
    const {projectId:dropped,...otherSources}=change.sources??{};
    const next={...change,data};
    if(Object.keys(otherSources).length)next.sources=otherSources;else delete next.sources;
    return next;
   });
  });
  // 同意所选：全选就直接提交；只选了一部分，先把这批草稿改成"只含所选"，再提交。
  // 两种路径都走 draft → commit（有回执、可撤销），不绕过批次直接写数据。
  wire('#batchCommit',async()=>{
   const selected=batch.changes.filter((_,index)=>!excluded.has(index));
   if(!selected.length)throw Error('至少选一项；如果这些都不要，点「全部不同意」');
   let id=batch.id,revision=batch.revision;
   if(selected.length!==batch.changes.length){
    const updated=await send('draft',{id:batch.id,revision:batch.revision,title:batch.title,changes:selected});
    if(!modal.current(request))return;
    id=updated.id;revision=updated.revision;
   }
   const receipt=await send('commit',{id,revision,key:'ui:'+id+':'+revision});
   if(!modal.current(request))return;
   dirty=false;
   notify('已同意 '+selected.length+' 项改动，已写进工作台');
   onCommitted(receipt);receiptDialog(receipt);
  });
  wire('#batchCancel',async()=>{
   const cancelled=await send('cancel_draft',{id:batch.id,revision:batch.revision});
   if(!modal.current(request))return;dirty=false;notify('已全部不同意：数据一点没改');modal.close();
  });
  wire('#batchLater',()=>{dirty=false;modal.close()});
  // "缺依据"就地补：只改这一批草稿里对应那条变更，不绕过批次。
  for(const button of body.querySelectorAll('[data-fixevidence]'))button.onclick=async()=>{
   const index=+button.dataset.fixevidence;
   const input=body.querySelector('[data-evidence="'+index+'"]');
   const value=input?.value?.trim();
   if(!value)throw Error('先写一句依据：为什么把它们连在一起');
   const changes=batch.changes.map((change,position)=>position===index?{...change,data:{...change.data,evidence:value,reason:value},sources:{...(change.sources??{}),evidence:'你在确认时补写'}}:change);
   const updated=await send('draft',{id:batch.id,revision:batch.revision,title:batch.title,changes});
   if(!modal.current(request))return;
   await review(updated.id);
  };
  return true;
 }
 function receiptDialog(receipt){
  const request=modal.begin();if(request===null)return;
  const html=`<p class="notice" data-receipt-note="1">改动已经生效。如果反悔，可以撤销——撤销同样会先让你确认。</p><div class="proof"><small>记录编号 ${esc(receipt.id)} · ${esc(String(receipt.at).slice(0,19).replace('T',' '))}</small></div><div class="modalactions"><button class="btn" id="receiptUndo">撤销这次修改</button><button class="btn" id="receiptClose">关闭</button></div>`;
  if(!modal.present(request,{title:'改动记录',type:'记录编号',html}))return;
  wire('#receiptUndo',async()=>{const draft=await send('undo_draft',{key:receipt.key});if(!modal.current(request))return;await review(draft.id)});
  wire('#receiptClose',()=>modal.close());
 }
 /** 你自己的操作：直接生效，不打断你；顶部给一条「已保存 · 撤销」。
 *  与 AI 提议的区别只在"要不要你点头"——落库路径仍然是 draft → commit（有记录编号、可撤销）。 */
 function undoBar(){
  let bar=document.querySelector('#undobar');
  if(!bar){
   bar=document.createElement('div');bar.id='undobar';bar.className='undobar';bar.hidden=true;
   bar.innerHTML='<span data-undotext="1"></span><button class="btn" type="button" data-undobutton="1">撤销</button>';
   document.body.appendChild(bar);
  }
  return bar;
 }
 async function apply(title,changes,{label}={}){
  const draft=await send('draft',{title,changes});
  const key='ui:'+draft.id+':'+draft.revision;
  try{
   const receipt=await send('commit',{id:draft.id,revision:draft.revision,key});
   onCommitted(receipt);
   showSaved(label??title,receipt);
   return receipt;
  }catch(error){
   // 内容在你动手前被别处改过：用**最新版本**重放你这次改动（只重放你自己的字段，不覆盖别人的改动）。
   if(error?.code==='CONFLICT'){
    try{
     const refreshed=[];
     for(const change of changes){
      if(change.op!=='update'){refreshed.push(change);continue}
      const {item}=await send('get',{id:change.id});
      if(!item||item.archived){refreshed.push(change);continue}
      refreshed.push({...change,expectedRevision:item.revision,data:{...item.data,...change.data}});
     }
     const fresh=await send('draft',{title,changes:refreshed});
     const freshKey='ui:'+fresh.id+':'+fresh.revision;
     const receipt=await send('commit',{id:fresh.id,revision:fresh.revision,key:freshKey});
     // 冲突重放成功后，**把原来那份冲突草稿撤掉**：
     // 否则它会永远躺在收件箱里，而且带着过期的 expectedRevision，你点「同意」必然冲突。
     // （实测：某条判断的「谁能看」被连点三次，收件箱里留下 3 条一模一样的僵尸条目，
     //   而这三次改动其实**早就直接生效了** —— 收件箱里躺着一堆"已经做完的事"，最扰人。）
     await send('cancel_draft',{id:draft.id,revision:draft.revision}).catch(()=>{});
     onCommitted(receipt);
     showSaved(label??title,receipt);
     notify('这条内容刚被改过，已按最新内容保存你的改动');
     return receipt;
    }catch{/* 重放也不行就按下面的失败路径处理，如实告诉用户 */}
   }
   // 断网/超时不丢你的输入：草稿留着，给一个「重试」，且复用同一把幂等键——重试不会写两遍。
   showRetry(label??title,{id:draft.id,revision:draft.revision,key},error);
   throw error;
  }
 }
 /** 保存失败：字还在、位置还在，点一下就重试（同一把键，最多写一次）。 */
 function showRetry(text,target,error){
  const bar=undoBar();
  bar.querySelector('[data-undotext]').textContent='没能保存：'+text+'（'+(error?.message??'连接失败')+'）';
  const button=bar.querySelector('[data-undobutton]');
  button.textContent='重试';
  bar.hidden=false;
  if(bar._timer)clearTimeout(bar._timer);
  button.onclick=async()=>{
   button.disabled=true;
   try{
    const receipt=await send('commit',target);
    onCommitted(receipt);
    button.textContent='撤销';
    showSaved(text,receipt);
    notify('已保存');
   }catch(retryError){notify(retryError.message,true)}
   finally{button.disabled=false}
  };
 }
 function showSaved(text,receipt){
  const bar=undoBar();
  const label=bar.querySelector('[data-undotext]');
  const button=bar.querySelector('[data-undobutton]');
  // VI §14 V8 表要求这条**逐字**是「已保存 · 撤销」（标签 + 那个「撤销」按钮合起来就是这句）。
  // 刚做的是哪一件事改挂 title：信息没丢，但不占这句正文（用户 2026-10-14：信息要密，不要无关信息）。
  label.textContent='已保存 · ';
  bar.title='已保存：'+text;
  bar.hidden=false;
  let busy=false;
  // 常驻（VI §14 V8「左下常驻」+ 03 §3 丝滑标准「随时可退」）。
  // 原来 9 秒后自己消失 —— 用户离开一会儿回来就再也撤不掉了，撤销等于没有。
  // 它在下一次保存时被同一条替换，或点「撤销」用掉，不需要定时器。
  if(bar._timer){clearTimeout(bar._timer);bar._timer=null}
  button.onclick=async()=>{
   if(busy)return;busy=true;button.disabled=true;
   try{
    const draft=await send('undo_draft',{key:receipt.key});
    const preview=await send('preview',{id:draft.id});
    await send('commit',{id:draft.id,revision:preview.revision,key:'ui:undo:'+draft.id+':'+preview.revision});
    notify('已撤销');
    clearTimeout(bar._timer);bar.hidden=true;onCommitted?.(null);
   }catch(error){notify(error.message,true)}
   finally{busy=false;button.disabled=false}
  };
 }
async function review(id){
  const request=token=modal.begin();if(request===null)return null;
  const batch=await send('preview',{id});if(!modal.current(request))return null;
  await loadProjects();if(!modal.current(request))return null;
  present(request,batch,new Set(),false);return batch;
 }
 async function draft(title,changes){const batch=await send('draft',{title,changes});await review(batch.id);return batch}
 return {open:review,draft,apply,showSaved,close:modal.close,dispose(){modal.invalidate(token)}};
}
