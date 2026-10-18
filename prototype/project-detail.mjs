import {inlineField, appendInlineFields} from './inline-edit.mjs';
import {priorityOptions} from './editor.mjs';
import {dayText} from './human-time.mjs';
import {populatedProjectHtml} from './project-populated.mjs';
import {escapeHtml} from './project-render.mjs';
import {sharedModal} from './modal.mjs';
import {refLabels} from './ref-labels.mjs';

export function createProjectDetail(document,send,{openGraph,openIntake,onIntake,openTask,onEdit,onOpenFolder,openFileDialog,onAdvanceStage,onNewTask,onLinkMaterial,onOpenMaterial,onUnlinkMaterial,onInlineChange,batch=null,notify=()=>{}}){
 const modal=sharedModal(document);let token;
 async function open(id){
  const request=token=modal.begin();if(request===null)return;
  const {item}=await send('get',{id});if(!modal.current(request))return;
  if(!item||item.kind!=='project'||item.archived)throw Error('项目已归档或不可用，请刷新');
  const data=item.data;
  // 面板对所有项目都用同一套结构：没有交付项时也要能看到阶段、任务与材料（这是管理入口，不是成绩单）。
  const html=await populatedProjectHtml(item,send);
  if(!modal.present(request,{title:data.title,type:'项目',html}))return;
  const body=document.querySelector('#detailbody');
  const actions=document.createElement('div');actions.className='modalactions';
  const make=(label,cls,run,id)=>{const button=document.createElement('button');button.className='btn'+(cls?' '+cls:'');button.textContent=label;if(id)button.id=id;button.onclick=run;actions.append(button);return button};
  // 项目文件夹：有就提供"打开"，没有就提示去编辑里填；创建走已有的目录接口（工作区内的相对路径）。
  if(onOpenFolder)make('打开项目文件夹','',()=>onOpenFolder(data.folder),'newprojectfolder');
  else if(openFileDialog)make('打开文件与资料','',()=>openFileDialog({path:data.folder||''}),'newprojectfiles');
  make('在画布中查看关联','',()=>openGraph?.(item.id),'newprojectgraph');
 if(!body.querySelector('#newprojectintake'))make('为该项目录入资料','',()=>openIntake?.(item.id),'newprojectintake');
 make('编辑项目','primary',()=>onEdit?.('project',item),'newprojectedit');
  body.append(actions);
  // ---- 项目管理面板的交互：阶段推进 / 新建任务 / 关联材料 / 取消关联 / 打开材料 ----
  const rail=body.querySelector('[data-phase-rail]');
  if(rail){
   // 点任意一格直接切到那个阶段：不再需要"滚到底 → 编辑 → 选下拉 → 保存"四步。
   // 当前阶段那格点了没变化，直接忽略（避免一次没有意义的写入）。
   for(const chip of rail.querySelectorAll('[data-phase-set]')){
    if(chip.classList.contains('current')){chip.disabled=true;continue}
    chip.onclick=()=>onAdvanceStage?.(item,chip.dataset.phaseSet);
   }
  }
  const newTask=body.querySelector('[data-newtask]');
  if(newTask)newTask.onclick=()=>onNewTask?.(item.id);
  const link=body.querySelector('[data-linkmaterial]');
  if(link)link.onclick=()=>onLinkMaterial?.(item.id);
  const intake=body.querySelector('[data-intake]');
  if(intake)intake.onclick=()=>(onIntake??openIntake)?.(item.id);
  for(const button of body.querySelectorAll('[data-material-open]'))button.onclick=event=>{event.stopPropagation();onOpenMaterial?.(button.dataset.materialOpen)};
  for(const button of body.querySelectorAll('[data-material-unlink]'))button.onclick=event=>{event.stopPropagation();onUnlinkMaterial?.(button.dataset.materialUnlink,item.id)};
  // 合作机构与负责人：PRD v1.2 PJ-06 要求的字段，此前只在数据里、界面看不到。
  // 合作机构 / 负责人 / 计划区间：原来是一行**纯文本**，点不动，旁边还写着"可在「编辑项目」里补充"——
  // 界面在指路让人去走那 6 步。现在每个字段本身就是可点的：点一下就地改，改完直接生效（可撤销）。
  // 2026-10-15 补齐另外四个（名称 / 目标 / 重要程度 / 紧急程度）：面板上看得见的字段，
  // 就该在看得见的地方改得动，不必为一个字段滚回去开「编辑项目」。
  const refLine=document.createElement('div');refLine.className='inlinerefs';refLine.dataset.refsLine='1';
  actions.before(refLine);
  void (async()=>{
   if(!refLine.isConnected)return;
   const box=document.createElement('div');box.className='inlinefields';refLine.append(box);
   const ownerOptions=[['','未设置'],...((await send('list',{kind:'person',limit:200}).catch(()=>({items:[]}))).items??[]).filter(x=>!x.archived).map(x=>[x.id,x.data?.title??x.id])];
   const partnerOptions=[['','未设置'],...((await send('list',{kind:'organization',limit:200}).catch(()=>({items:[]}))).items??[]).filter(x=>!x.archived).map(x=>[x.id,x.data?.title??x.id])];
   if(!box.isConnected)return;
   const commit=(field,label)=>async next=>{
    // 提交前先取一次**最新版本**：面板打开期间这条记录可能已经被改过（例如刚就地新建并挂上一个组织）。
    // 拿着打开时的旧版本号提交，会被服务端判为"这条内容在你操作前刚被改过"而整条拒绝 ——
    // 实测表现是"同一面板里改第二个字段必然失败，界面却显示已改"。用最新数据提交才落得下去。
    let fresh=item;
    try{const result=await send('get',{id:item.id});if(result?.item&&!result.item.archived)fresh=result.item}
    catch{/* 取不到就按原来的版本提交；真失败由保存路径如实提示，不假装成功 */}
    await onInlineChange?.(fresh,{[field]:next});
    // 改了名字，弹窗标题行也要跟着改 —— 否则标题还写着旧名字，看着像没保存成功。
    if(field==='title'){const header=document.querySelector('#detailtitle');if(header&&next)header.textContent=next}
    notify(label+'已改');
   };
   const level=value=>priorityOptions.find(([key])=>key===value)?.[1]??'未设置';
   appendInlineFields(box,[
    inlineField(document,{label:'名称',value:data.title??'',display:data.title||'未设置',onCommit:commit('title','名称'),notify}),
    // 目标是一整句话，用多行输入；值那一行只显示一行（CSS 截断），点了才展开。
    inlineField(document,{label:'目标',value:data.goal??'',display:data.goal||'未设置',type:'textarea',onCommit:commit('goal','目标'),notify}),
    // 合作机构 / 负责人：下拉里除了库里已有的记录，还有「＋ 新建组织 / 联系人」——
    // 免得"库里唯一那个组织"被硬套到不相干的项目上（用户 2026-10-15 点名）。
    inlineField(document,{label:'合作机构',value:data.partnerId??'',display:partnerOptions.find(([key])=>key===data.partnerId)?.[1]??'未设置',options:partnerOptions,create:{kind:'organization',batch},onCommit:commit('partnerId','合作机构'),notify}),
    inlineField(document,{label:'负责人',value:data.ownerId??'',display:ownerOptions.find(([key])=>key===data.ownerId)?.[1]??'未设置',options:ownerOptions,create:{kind:'person',batch},onCommit:commit('ownerId','负责人'),notify}),
    // 重要/紧急程度与「编辑项目」共用同一张取值表（editor.mjs 导出），不自己编一套。
    inlineField(document,{label:'重要程度',value:data.importance??'',display:level(data.importance),options:priorityOptions,onCommit:commit('importance','重要程度'),notify}),
    inlineField(document,{label:'紧急程度',value:data.urgency??'',display:level(data.urgency),options:priorityOptions,onCommit:commit('urgency','紧急程度'),notify}),
    inlineField(document,{label:'开始',value:data.startDate??'',display:data.startDate?dayText(data.startDate):'未设置',type:'date',format:dayText,onCommit:commit('startDate','开始'),notify}),
    inlineField(document,{label:'截止',value:data.dueDate??'',display:data.dueDate?dayText(data.dueDate):'未设置',type:'date',format:dayText,onCommit:commit('dueDate','截止'),notify}),
   ]);
  })();
  for(const button of body.querySelectorAll('[data-task]'))button.onclick=()=>openTask?.(button.dataset.task);
  return item;
 }
 return {open,close:modal.close,dispose(){modal.invalidate(token)}};
}
