import {sharedModal} from './modal.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';

/** 「录入」补齐 PRD v1.1 IN-01 承诺的能力（体检 A4）：
 *  粘贴文本 / 选择文件 / 拖放文件 / 输入链接 / 指定目标项目 / 指定目标任务。
 *
 *  三条边界，都是有意写死的：
 *  1. **一切仍然只生成草稿**——落库要走 draft → 收件箱确认 → commit，与页面其它入口同一批批次；
 *  2. **链接不抓正文**：链接抓取属"未接入"，这里只登记来源链接并写明正文未抓取，不假装已读到内容；
 *  3. **拖放不越权**：拖进来的文件由浏览器直接读成文本快照（用户主动提供），
 *     工作台服务端仍然只能读已授权目录，拖放不会带来任何新的目录权限——界面上如实写明这一点。 */

const maxDroppedBytes=2*1024*1024;
const kindLabels={artifact:'资料记录',topic:'研究议题'};

function readDroppedFile(file){
 if(typeof file.text==='function')return file.text();
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(String(reader.result??''));
  reader.onerror=()=>reject(Error('读取拖入的文件失败'));
  reader.readAsText(file);
 });
}

export function createIntake(document,send,batch,{notify=()=>{},openSearch,onBatch,projects=[],tasks=[]}={}){
 const modal=sharedModal(document);
 // 候选项由控制器在每次 load() 后喂进来（来自真实记录）；这里不自己缓存业务数据。
 let chosen={projects:[],tasks:[]};
 function setChoices(next){if(next&&Array.isArray(next.projects))chosen.projects=next.projects;if(next&&Array.isArray(next.tasks))chosen.tasks=next.tasks}
 async function open(preset={}){
  const request=modal.begin();if(request===null)return null;
  let projectList=chosen.projects.length?[...chosen.projects]:(Array.isArray(projects)?[...projects]:[]);
  let taskList=chosen.tasks.length?[...chosen.tasks]:(Array.isArray(tasks)?[...tasks]:[]);
  if(!projectList.length){try{projectList=(await send('list',{kind:'project',limit:500})).items.filter(item=>!item.archived).map(item=>[item.id,item.data.title??item.id])}catch{projectList=[]}}
  if(!taskList.length){try{taskList=(await send('list',{kind:'task',limit:500})).items.filter(item=>!item.archived).map(item=>[item.id,item.data.title??item.id])}catch{taskList=[]}}
  if(!modal.current(request))return null;
  const projectOptions=projectList.map(entry=>Array.isArray(entry)?entry:[entry.id,entry.title??entry.id]);
  const taskOptions=taskList.map(entry=>Array.isArray(entry)?entry:[entry.id,entry.title??entry.id]);
  const state={kind:'artifact',grantId:null,path:null,version:null,dropped:null};
  const html=`
   <div class="formrow">${selectHtml({name:'kind',attribute:'data-intake',label:'记录类型',value:'artifact',options:Object.entries(kindLabels),placeholder:'资料记录'})}</div>
   <label data-intake-field="1">名称<input data-intake="title" id="intaketitle" placeholder="例如：会议纪要 · 示例科技路演"></label>
   <label data-intake-field="1">内容（粘贴文本）<textarea data-intake="content" id="intakecontent" spellcheck="false" placeholder="把会议纪要、笔记或一段想法粘在这里"></textarea></label>
   <label data-intake-field="1">来源链接（可选）<input data-intake="link" id="intakelink" placeholder="https://…（只登记链接，不抓取正文）"></label>
   <div class="formrow">${selectHtml({name:'projectId',attribute:'data-intake',label:'目标项目',value:preset.projectId??'',options:[['','未归属'],...projectOptions],placeholder:'未归属'})}</div>
   <div class="formrow">${selectHtml({name:'taskIds',attribute:'data-intake-task',label:'目标任务（可多选）',value:'',options:[['','添加任务'],...taskOptions],placeholder:'＋ 添加任务'})}<span class="refchips" data-intakechips="1"></span><input type="hidden" data-intake="taskIds" value=""></div>
   <div class="formrow"><button class="btn" id="intakepick" type="button">选择授权目录里的文件</button></div>
   <div id="intakefilebody" class="relationlist"></div>
   <div class="dropzone" id="intakedrop" data-intakedrop="1" tabindex="0">把文件拖到这里（浏览器直接读成文本当时的副本，不会让工作台获得新的目录权限）</div>
   <p class="notice" data-intakedropnote="1">拖放只把你选中的这个文件读成文本当时的副本；工作台服务端仍然只能读「空间与设置 → 目录授权」里已授权的目录。链接只登记来源，抓取正文尚未接入。</p>
   <p class="notice">这里生成的是**待你确认的改动**：进「收件箱」同意后才写进工作台；在那之前不动任何记录。</p>
   <div class="modalactions"><button class="btn primary" id="intakedraft">生成待你确认的改动</button><button class="btn" id="intakesearch">从知识检索摘录</button><button class="btn" id="intakeclose">关闭</button></div>`;
  if(!modal.present(request,{title:'录入材料',type:'录入',html}))return null;
  const body=document.querySelector('#detailbody');
  wireSelects(body,{document});
  const field=name=>body.querySelector('[data-intake="'+name+'"]');
  const chips=body.querySelector('[data-intakechips]');
  const picked=new Map();
  const syncTasks=()=>{const hidden=field('taskIds');if(hidden)hidden.value=[...picked.keys()].join(',');
   if(chips)chips.replaceChildren(...[...picked].map(([id,title])=>{
    const chip=document.createElement('span');chip.className='refchip';chip.dataset.taskchip=id;
    chip.append(Object.assign(document.createElement('span'),{textContent:title}));
    const remove=document.createElement('button');remove.type='button';remove.className='refchip-remove';
    remove.setAttribute('aria-label','移除任务 '+title);remove.dataset.taskremove=id;
    remove.onclick=()=>{picked.delete(id);syncTasks()};
    chip.append(remove);return chip;
   }))};
  const taskSelect=body.querySelector('[data-intake-task="taskIds"]');
  if(taskSelect)taskSelect.onchange=()=>{
   const value=taskSelect.value;
   if(!value)return;
   const label=taskOptions.find(([id])=>id===value)?.[1]??value;
   picked.set(value,label);syncTasks();
   taskSelect.value='';const text=taskSelect.closest('[data-viselect]')?.querySelector('[data-viselect-text]');
   if(text)text.textContent='添加任务';
  };
  const clearFile=()=>{state.grantId=null;state.path=null;state.version=null;state.dropped=null};
  // 从授权目录选文件：列目录 + 读文本（读取不写记录）。
  const fileBody=body.querySelector('#intakefilebody');
  const pickButton=body.querySelector('#intakepick');
  if(pickButton)pickButton.onclick=async()=>{
   pickButton.disabled=true;
   try{
    const {items}=await send('file_grants');
    const grants=items.filter(grant=>grant.read);
    if(!grants.length){fileBody.textContent='当前工作区还没有文件目录授权。做法：打开「设置 → 能读写哪些文件夹」，给需要的文件夹点「授权只读」或「授权读写」（立即生效，不必重启）。';return}
    if(!modal.current(request))return;
    fileBody.replaceChildren();
    let grantId=state.grantId??grants[0].id,currentPath='';
    const grantRow=document.createElement('div');grantRow.className='formrow';
    const renderList=async()=>{
     let result;
     try{result=await send('file_list',{grantId,path:currentPath||'.',offset:0,limit:50})}
     catch(error){fileBody.append(Object.assign(document.createElement('p'),{className:'notice',textContent:'无法读取该目录：'+error.message}));return}
     if(!modal.current(request))return;
     for(const node of [...fileBody.querySelectorAll('[data-intakefile]')])node.remove();
     if(currentPath){const up=document.createElement('button');up.type='button';up.className='btn';up.dataset.intakefile='up';up.textContent='上级目录';
      up.onclick=()=>{currentPath=currentPath.split('/').slice(0,-1).join('/');renderList()};fileBody.append(up)}
     const caption=document.createElement('p');caption.dataset.intakefile='caption';caption.textContent='当前目录：'+(currentPath||'/');fileBody.append(caption);
     for(const entry of result.items.slice(0,40)){
      const button=document.createElement('button');button.type='button';button.className='btn';button.dataset.intakefile=entry.name;
      button.textContent=(entry.type==='directory'?'目录 · ':'文件 · ')+entry.name;
      button.onclick=async()=>{
       if(entry.type==='directory'){currentPath=[currentPath,entry.name].filter(Boolean).join('/');renderList();return}
       const path=[currentPath,entry.name].filter(Boolean).join('/');
       button.disabled=true;
       try{
        const file=await send('file_read',{grantId,path});
        if(!modal.current(request))return;
        state.grantId=grantId;state.path=path;state.version=file.version;state.dropped=null;
        field('content').value=file.content;
        if(!field('title').value.trim())field('title').value=entry.name;
        notify('已读取 '+path+'（版本 '+file.version+'）；内容还没有保存回记录');
       }catch(error){notify(error.message,true)}finally{if(button.isConnected)button.disabled=false}
      };
      fileBody.append(button);
     }
    };
    const grantSelect=document.createElement('div');grantSelect.innerHTML=selectHtml({name:'grant',attribute:'data-intakegrant',label:'授权目录',value:grantId,options:grants.map(grant=>[grant.id,(grant.label||grant.id)+(grant.write?' · 可读写':' · 只读')])});
    grantRow.append(grantSelect);fileBody.prepend(grantRow);
    wireSelects(fileBody,{document});
    const select=grantRow.querySelector('[data-intakegrant="grant"]');
    if(select)select.onchange=()=>{grantId=select.value;currentPath='';renderList()};
    await renderList();
   }catch(error){notify(error.message,true)}finally{if(pickButton.isConnected)pickButton.disabled=false}
  };
  // 拖放：浏览器直接读文本快照；超限或读不了都如实说。
  const drop=body.querySelector('#intakedrop');
  if(drop){
   drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('over')});
   drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
   drop.addEventListener('drop',async event=>{
    event.preventDefault();drop.classList.remove('over');
    const file=event.dataTransfer?.files?.[0];
    if(!file){notify('没有读到拖入的文件',true);return}
    if(Number.isFinite(file.size)&&file.size>maxDroppedBytes){notify('拖入的文件超过 2MB：请改用「选择授权目录里的文件」按授权目录读取',true);return}
    try{
     const text=await readDroppedFile(file);
     if(!modal.current(request))return;
     clearFile();state.dropped=file.name;
     field('content').value=text;
     if(!field('title').value.trim())field('title').value=file.name.replace(/\.[^.]+$/,'');
     notify('已读取你拖入的 '+file.name+'（'+text.length+' 字）；这是当时的副本，没有保存回任何文件');
    }catch(error){notify(error.message,true)}
   });
  }
  const draftButton=body.querySelector('#intakedraft');
  if(draftButton)draftButton.onclick=async()=>{
   draftButton.disabled=true;
   try{
    const title=field('title').value.trim();
    if(!title)throw Error('请先填写名称');
    const kind=field('kind').value||'artifact';
    const content=field('content').value;
    const link=field('link').value.trim();
    const projectId=field('projectId').value;
    const taskIds=[...picked.keys()];
    if(!content.trim()&&!link&&!state.path&&!state.dropped)throw Error('还没有可录入的内容：请粘贴文本、选择文件、拖入文件或填一个来源链接');
    if(kind==='topic'&&taskIds.length)throw Error('研究议题不挂任务：请改选「资料记录」，或先不选目标任务');
    const data={title};
    if(content.trim())data.content=content;
    if(state.path){data.path=state.path;data.fileGrantId=state.grantId}
    if(projectId)data.projectId=projectId;
    if(kind==='artifact'&&taskIds.length)data.taskIds=taskIds;
    const sources={};
    if(state.path)sources.content='读取授权目录文件 '+(state.path)+'（版本 '+state.version+'）';
    else if(state.dropped)sources.content='用户拖入的文件 '+state.dropped;
    else if(content.trim())sources.content='用户粘贴的文本';
    if(state.path)sources.path='用户选择的文件';
    if(link){data.sourceRefs=[link];data.description='来源链接：'+link+'（正文未抓取：链接抓取尚未接入）';sources.description='用户输入的链接'}
    if(projectId)sources.projectId='用户在录入对话框指定';
    if(kind==='artifact'&&taskIds.length)sources.taskIds='用户在录入对话框指定';
    const draft=await send('draft',{title:'录入'+kindLabels[kind]+' · '+title,changes:[{op:'create',kind,data,sources}]});
    if(!modal.current(request))return;
    notify('已生成待确认的改动，同意后写进工作台');
    modal.close();
    if(onBatch)onBatch(draft.id);else await batch.open?.(draft.id);
   }catch(error){notify(error.message,true)}finally{if(draftButton.isConnected)draftButton.disabled=false}
  };
  const searchButton=body.querySelector('#intakesearch');
  if(searchButton)searchButton.onclick=()=>{modal.close();openSearch?.()};
  if(body.querySelector('#intakeclose'))body.querySelector('#intakeclose').onclick=()=>modal.close();
  return true;
 }
 return {open,setChoices};
}
