import {toZonedDateTime,validDate} from '../src/validation.mjs';
import {sharedModal} from './modal.mjs';
import {escapeHtml as esc} from './project-render.mjs';
import {validateData} from '../src/validation.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';
import {mountDirectoryBrowser,humanFolderError,suggestFolders,renderFolderCandidates} from './directory-browser.mjs';

const labels={project:'项目',task:'任务',artifact:'文件与资料',event:'日程与事务',topic:'研究议题',memoryRef:'记忆引用',organization:'组织',person:'联系人',judgment:'判断'};
// A3：字段按**分节**组织（每节一个容器、不再一路平铺），输入一律全宽。
// 标签里不再写「（YYYY-MM-DD）」「（工作区内相对路径，例如 …）」这类开发式提示：
// 提示要么变成输入框的占位符，要么写在节内一句人话里——不把开发语言端给用户。
const statusOptions=[['todo','待办'],['waiting','等待'],['in_progress','进行中'],['done','已完成'],['cancelled','已取消']];
const stageOptions=[['','未设置'],['接触','接触'],['需求','需求'],['方案','方案'],['验证','验证'],['复盘','复盘']];
// 重要程度 / 紧急程度只有这三个真实取值。就地编辑直接 import 这一份（VI §6：同一控件全站唯一实现）
// —— 两处各写一张表，迟早会出现"弹窗里有四档、详情里只有三档"。
export const priorityOptions=[['','未设置'],['high','高'],['medium','中'],['low','低']];
const spec={
 project:[
  ['基本信息',[['goal','目标 / 预期成果','textarea']]],
  ['归属与负责人',[['organizationId','主责机构','ref','organization'],['partnerId','合作机构','ref','organization'],['ownerId','负责人','ref','person'],['roleTemplate','项目模板','select',[['','不套模板'],['delivery','客户交付'],['ecosystem','生态战略'],['investment','研判投资'],['research','研究议题'],['custom','自定义']]]]],
  ['优先级',[['importance','重要程度','select',priorityOptions],['urgency','紧急程度','select',priorityOptions]]],
  ['计划',[['stage','阶段','select',stageOptions],['startDate','计划开始','date'],['dueDate','计划截止','date'],['folder','项目文件夹','folder']]]],
 task:[
  ['基本信息',[['expectedOutput','预期成果','textarea'],['status','业务状态','select',statusOptions],['blockedReason','等待原因','text',undefined,'例如：等对方的资料确认'],['executionTarget','执行端','select',[['','默认：当前 DSH 主机'],['local','当前 DSH 主机']]]]],
  ['归属与负责人',[['ownerId','负责人','ref','person'],['deliverableId','所属交付项','deliverable']]],
  ['计划',[['dueDate','截止日期','date'],['dependsOn','依赖任务','ref-multi','task']]]],
 event:[
  ['基本信息',[['eventType','事务类型','select',[['meeting','会议'],['travel','行程'],['other','其他']]],['location','地点','text',undefined,'例如：线上会议']]],
  ['计划',[['startDate','开始时间','text',undefined,'例如：2026-10-20 10:30'],['endDate','结束时间','text',undefined,'例如：2026-10-20 11:30'],['timezone','时区','text',undefined,'例如：Asia/Shanghai']]],
  ['参与人',[['attendees','参与人','ref-multi','person']]]],
 organization:[['基本信息',[['defaultRole','分类（默认角色）','text',undefined,'例如：客户 / 伙伴 / 供应；留空=未分类'],['website','网站','text',undefined,'例如：https://example.com'],['contactId','主要联系人','ref','person']]],['备注',[['note','备注','textarea',undefined,'例如：合作到哪一步、谁在对接']]]],
 person:[['基本信息',[['organizationId','所属组织','ref','organization'],['email','邮箱','text',undefined,'例如：name@example.com']]],['备注',[['note','备注','textarea',undefined,'例如：怎么认识的、负责哪一块']]]],
 artifact:[['基本信息',[['path','关联文件路径','text',undefined,'相对于授权目录，例如 notes/meeting.md'],['grant','授权目录','grant'],['content','内容','textarea']]]],
 topic:[['基本信息',[['content','内容','textarea']]]],
 memoryRef:[['基本信息',[['provider','来源提供方'],['reference','记忆引用标识'],['content','内容','textarea']]]],
 // 判断（宪章第三条）：依据由 Agent 从会话原文 / 文件 / 录音里带进来，人只填「什么时候成立、状态、不确定性」。
 judgment:[['判断',[['share','谁能看','select',[['private','仅自己'],['team','可以给同事看']]],['evidence','依据（每行一条，写出处原文）','textarea'],
  // 出处（可选）：每行对应上面一条依据。填了它，点「看原始出处」才真的能回到那一份文件/录音的**那一段**。
  ['evidenceRef','出处（可选，每行对应上面一条）：文件名@第几段，或录音文件名@第几秒 · 也可以直接贴网址','textarea'],['validFrom','什么时候成立','date'],['status','状态','select',[['current','当前有效'],['checking','待核对'],['overturned','已被推翻']]],['overturnReason','推翻理由（选「已被推翻」时必填，一句话就行）','textarea'],['uncertainty','不确定性（还没验证的部分）','textarea'],['reviewBy','何时该复核','date']]]]
};
const scoped=['task','artifact','event','topic','memoryRef','judgment'];

/** 引用类记录在界面上的说法（新建入口、提示、回执都用它）：一处定义，两处使用。 */
export function refNoun(refKind){return refKind==='person'?'联系人':refKind==='organization'?'组织':refKind==='task'?'任务':'记录'}
/** 建好之后的回执（编辑弹窗与就地编辑共用同一句，不各写各的）。 */
export const createdNotice=(noun,title)=>'已新建并选中：'+title+'（在左下角可以撤销）';

/** 「＋ 新建联系人 / 组织」的**唯一实现**（VI §6 同一控件唯一实现）。
 *  编辑弹窗在构造时把真实写入路径（batch）登记到这里：就地编辑（项目/任务详情）拿不到 batch，
 *  但必须走**同一条**写入路径 —— 否则"新建"要么落不了库，要么绕过回执另起一套。
 *  没有登记的嵌入方（旧原型）不显示新建入口：宁可不给，也不给一个点了没反应的按钮（约束三）。 */
let refWriter=null;
export const referenceWriter=()=>refWriter;

/** 展开一行「输入名字 → 建好并选中」，返回这一行。调用方决定插在哪里、建完怎么选中。
 *  为什么不弹第二层弹窗：工作台只有一个居中弹窗（VI §6），套一层会把当前表单顶掉，刚填的内容全丢。 */
export function refCreateRow(document,{kind,notify=()=>{},batch,onCreated=async()=>{},onCancel=null,announce=true}={}){
 const noun=refNoun(kind);
 const line=document.createElement('div');
 line.className='refcreaterow';line.dataset.refcreaterow='1';
 const input=document.createElement('input');
 input.placeholder=kind==='person'?'联系人姓名':'组织名称';
 input.setAttribute('aria-label',input.placeholder);
 const ok=document.createElement('button');ok.type='button';ok.className='btn primary';ok.textContent='建好并选中';
 const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.textContent='取消';
 line.append(input,ok,cancel);
 cancel.onclick=()=>{if(onCancel)onCancel();else line.remove()};
 ok.onclick=async()=>{
  const title=input.value.trim();
  if(!title){notify('先写个名称');input.focus();return}
  ok.disabled=true;
  try{
   const id=globalThis.crypto.randomUUID();
   const apply=batch.apply.bind(batch);
   await apply('新建'+noun+' · '+title,[{op:'create',id,kind,data:{title}}],{label:'新建'+noun});
   await onCreated(id,title);
   line.remove();
   if(announce)notify(createdNotice(noun,title));
  }catch(error){notify(error.message,true)}
  finally{ok.disabled=false}
 };
 return line;
}

/** V7 centred dialog for creating and editing real records through the versioned batch service. */
export function createEditor(document,send,batch,{notify=()=>{},onIntake=null}={}){
 const modal=sharedModal(document);let token=null;
 // 把真实写入路径登记给「＋ 新建联系人 / 组织」的唯一实现：就地编辑要用同一条路（见 refCreateRow）。
 refWriter={batch};
 const wire=(selector,run)=>{const node=document.querySelector(selector);if(!node)return;let pending=false;node.onclick=async()=>{if(pending)return;pending=true;node.disabled=true;try{await run()}catch(error){notify(error.message,true)}finally{pending=false;if(node.isConnected)node.disabled=false}}};
 /** 引用类字段（合作机构 / 负责人 / 依赖任务 / 参与人）：
  *  这些字段在数据模型里**本来就有**，只是以前表单没暴露。选项来自真实记录，不让人手填 ID。
  *  多值字段用「已选标签 + 添加下拉」，值放 hidden input（逗号分隔），保存时还原成数组。 */
 function referencesHtml(name,text,type,options,refKind){
  const multi=type==='ref-multi';
  const chips=multi?`<span class="refchips" data-refchips="${esc(name)}"></span>`:'';
  const select=selectHtml({name:multi?name+'-add':name,label:text,value:'',options:[...(multi?[[(options[0]?.[0]??''),'添加']]:[]),...options],placeholder:multi?'添加':(options[0]?.[1]??'未选择')});
  // 候选为空不是"没事发生"，是**这里建不了下一步**：给一句人话 + 一个可点的按钮（宪章六·诚实）。
  const newKind=refNoun(refKind);
  const empty=!options.filter(option=>option[0]).length;
  const hint=empty&&refKind?`<p class="formhint">还没有可选的${newKind}。点右边「新建${newKind}」当场建一个，建完会自动选中。</p>`:'';
  const create=refKind?`<button class="btn refnew" type="button" data-refnew="${esc(refKind)}" data-reftarget="${esc(name)}"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>新建${newKind}</button>`:'';
  return `<div class="formfield ${refKind?'hasrefnew':''}">${chips}${select}${multi?`<input type="hidden" data-field="${esc(name)}" data-refmulti="1" value="">`:''}${create}${hint}</div>`;
 }

 // 每个字段都是块级的「标签 + 全宽控件」；提示只进占位符，不写进标签。
 function control([name,text,type='text',options,placeholder],refOptions={}){
  if(type==='ref'||type==='ref-multi')return referencesHtml(name,text,type,refOptions[options]??[],options);
  // 授权目录：材料必须能选自己是哪个授权目录里的文件（以前只能在文件页选，编辑器里看不到）。
  if(type==='grant')return `<div class="formrow">${selectHtml({name:'fileGrantId',label:text,value:'',options:refOptions.grants??[['','（没有可用的目录授权）']],placeholder:'选择授权目录'})}</div>`;
  // 交付项由所属项目定义：候选项在 dialog() 里按 projectId 载入，用同一套 VI 选择控件。
  if(type==='deliverable'){
   // 没有可选交付项（任务还没有所属项目）时，不给一句超长提示塞在下拉里，而是在字段下面写一行引导。
   const empty=(refOptions.deliverables??[]).every(option=>!option[0]);
   return `<div class="formfield"><span>${esc(text)}</span>${selectHtml({name,value:'',options:refOptions.deliverables??[],placeholder:'不挂交付项'})}${empty?'<p class="formhint">先在上面的「所属项目」里选一个项目，才会出现这个项目的交付项。</p>':''}</div>`;
  }
  if(type==='select')return `<div class="formfield"><span>${esc(text)}</span>${selectHtml({name,value:'',options,placeholder:options[0]?.[1]??'请选择'})}</div>`;
  if(type==='project')return `<div class="formfield"><span>${esc(text)}</span>${selectHtml({name,value:'',options,placeholder:'未归属'})}</div>`;
  if(type==='folder')return `<div class="formfield" data-folderfield="1"><span>${esc(text)}</span><div class="folderrow"><input data-field="${name}" placeholder="${esc(placeholder??'例如 项目/联合验证')}"><button class="btn" type="button" data-folderpick="1">选择文件夹</button></div><p class="formhint">只能选工作区里的文件夹。</p><div class="folderpanel" data-folderpanel="1" hidden></div><div class="folderfix" data-folderfix="1" hidden></div></div>`;
  const tag=type==='textarea'?`<textarea data-field="${name}"${placeholder?` placeholder="${esc(placeholder)}"`:''}></textarea>`
   :type==='date'?`<input type="date" data-field="${name}">`
   :`<input data-field="${name}"${placeholder?` placeholder="${esc(placeholder)}"`:''}>`;
  return `<div class="formfield"><span>${esc(text)}</span>${tag}</div>`;
 }

/** 引用字段的「新建联系人 / 组织」：就地建、就地选。
 *  为什么不弹第二层弹窗：工作台只有一个居中弹窗（VI §6 组件唯一），套一层会把当前表单顶掉，
 *  用户刚填的内容全丢。所以这里只展开一行输入，用同一套字段控件与真实写入路径。 */
/** 新建菜单的类型表：图标名必须已登记在 spec/registry.json 的 icons.items 里。 */
const MENU_GROUPS=[
 {title:'工作推进',items:[
  ['project','project','项目','有目标、有交付项、有阶段'],
  ['task','task','任务','一件事，带状态和截止日期'],
  ['event','calendar','日程与事务','会议、行程或其它安排'],
 ]},
 {title:'积累',items:[
  ['artifact','file','文件与资料','文件、纪要、录音这类材料'],
  ['topic','knowledge','研究议题','一个要研究清楚的问题'],
  ['judgment','check','判断','一条带依据、不确定性和成立条件的判断'],
  ['memoryRef','memory','记忆引用','引用一条记忆，并记下核对结果'],
 ]},
 {title:'谁参与',items:[
  ['organization','organization','组织','合作方、客户、机构'],
  ['person','person','联系人','负责人、对接人'],
 ]},
];
const menuGroups=()=>MENU_GROUPS;
/** 引用字段的「新建联系人 / 组织」：就地建、就地选。这里只负责"插到哪个字段、建完怎么选中"，
 *  输入行与写入路径用 top 层那一份 refCreateRow（编辑弹窗与就地编辑共用同一套）。 */
function wireRefCreate(scope,{kind,notify,batch}){
 const doc=scope.ownerDocument??globalThis.document;
 for(const button of scope.querySelectorAll('[data-refnew]')){
  button.onclick=()=>{
   const refKind=button.dataset.refnew;
   const field=button.closest('.formfield');
   if(!field||field.querySelector('[data-refcreaterow]'))return;
   const line=refCreateRow(doc,{kind:refKind,notify,batch,onCreated:(id,title)=>{
    // 选中新记录：写进 hidden input，并把它加进同一个下拉的候选里（下次打开也在）。
    const wrapper=field.querySelector('[data-viselect]');
    const hidden=wrapper?.querySelector('input[type="hidden"]');
    const text=wrapper?.querySelector('[data-viselect-text]');
    const list=wrapper?.querySelector('[data-viselect-list]');
    if(hidden)hidden.value=id;
    if(text)text.textContent=title;
    if(list){const option=doc.createElement('button');option.type='button';option.className='viselect-option';option.setAttribute('role','option');option.dataset.viselectOption=id;option.textContent=title;option.onclick=()=>{if(hidden)hidden.value=id;if(text)text.textContent=title;list.hidden=true;wrapper.querySelector('[data-viselect-button]')?.setAttribute('aria-expanded','false')};list.append(option)}
    const hint=field.querySelector('.formhint');if(hint)hint.remove();
   }});
   field.append(line);line.querySelector('input').focus();
  };
 }
 return scope;
}
 async function dialog(kind,existing,preset={}){
  const request=token=modal.begin();if(request===null)return null;
  let acknowledged=false;
  const projects=scoped.includes(kind)?(await send('list',{kind:'project',limit:500})).items.filter(x=>!x.archived):[];
  if(!modal.current(request))return null;
  // preset 用于"从项目里新建任务/材料"：预置 projectId，但仍走同一套草稿与确认。
  const data=existing?.data??(preset&&Object.keys(preset).length?{...preset}:{});
  // 引用类字段的候选来自真实记录：机构、联系人、任务（可执行任务），不让人手填 ID。
  const needs=kind==='project'?['organization','person']:kind==='task'?['person','task']:kind==='event'?['person']:[];
  const refOptions={};
  for(const refKind of needs){
   const list=refKind==='task'
    ?(await send('list',{kind:'task',limit:500})).items.filter(item=>!item.archived&&item.id!==existing?.id)
    :(await send('list',{kind:refKind,limit:500})).items.filter(item=>!item.archived);
   refOptions[refKind]=list.map(item=>[item.id,item.data.title||item.id]);
  }
  // 材料的授权目录候选：来自真实授权（读不到就只留一个说明项，不编目录名）。
  if(kind==='artifact'){
   try{
    const {items=[]}=await send('file_grants');
    refOptions.grants=items.filter(grant=>grant.read).map(grant=>[grant.id,(grant.label||grant.id)+(grant.write?' · 可读写':' · 只读')]);
   }catch{refOptions.grants=[]}
   if(!refOptions.grants.length)refOptions.grants=[['','（没有可用的目录授权）']];
  }
  // 交付项候选：取自任务所属项目（编辑时用数据里的 projectId，新建时用 preset）。
  if(kind==='task'){
   const projectId=(existing?.data??preset).projectId;
   if(projectId){
    try{
     const {item:project}=await send('get',{id:projectId});
     refOptions.deliverables=(project?.data?.deliverables??[]).map(entry=>[entry.id,entry.title+(entry.done?'（已完成）':'')]);
    }catch{refOptions.deliverables=[]}
   }else refOptions.deliverables=[];
   // 体检 P2：下拉里塞一句超长说明会挤爆控件；改成短的"先选所属项目"，真正的引导放在字段下方一行。
   if(!refOptions.deliverables.length)refOptions.deliverables=[['','先选所属项目']];
  }
  if(!modal.current(request))return null;
  // 分节：名称/说明永远在第一节；所属项目并入「归属与负责人」（没有这一节就并进第一节）。
  const plan=(spec[kind]||[]).map(([title,fields])=>[title,[...fields]]);
  if(!plan.length)plan.push(['基本信息',[]]);
  plan[0][1].unshift(['title','名称'],['description','说明','textarea']);
  if(scoped.includes(kind)){
   const owner=plan.find(([title])=>title==='归属与负责人');
   (owner?owner[1]:plan[0][1]).push(['projectId','所属项目','project',[['','未归属'],...projects.map(project=>[project.id,project.data.title])]]);
  }
  const fields=plan.map(([title,list])=>`<section data-formsection="1"><h3>${esc(title)}</h3>${list.map(field=>control(field,refOptions)).join('')}</section>`).join('');
  const checklist=kind==='project'||kind==='task'?`<section data-formsection="1"><h3>${kind==='project'?'交付项':'任务步骤'}</h3><p class="formhint">${kind==='project'?'勾选表示完成（计入项目完成度）；状态用于表达待办、进行中或受阻。':'勾选表示这一步已完成；业务进度按已完成步骤计算。'}</p><div id="objchecklist"></div><button class="btn" id="objadditem">添加条目</button></section>`:'';
  const html=`${fields}${checklist}<p class="notice">${esc(kind==='task'?'业务状态不控制执行器，保存也不会启动任务。':kind==='memoryRef'?'仅维护工作台引用与摘录，不会创建或修改 Mnemon 记忆。':kind==='event'?'保存内部日程，不发送邀请，不同步外部日历。':'你自己填的内容，保存后立刻生效；顶部会给一条「已保存 · 撤销」。')}</p><div class="modalactions"><button class="btn primary" id="objpreview">保存</button>${existing?'<button class="btn" id="objarchive">归档…</button><button class="btn" id="objdelete">删除…</button>':''}<button class="btn" id="objcancel">取消</button></div>`;
  // 标题行统一（体检 P3）：详情弹窗是「中文类型 / 记录名」，编辑器同样把**类型**放在 type 上、
// 记录名（新建/编辑 + 类型）放在 title 上——不再一处写「编辑 / 编辑项目」、另一处写「项目 / 联合验证」。
  // W2-6 未保存保护：改过表单后按 Esc / 点遮罩，先停一次并给出「继续编辑 / 放弃修改」，
  // 第二次 Esc 才算确认放弃（不弹第二层弹窗；工作台只有一个居中弹窗）。
  let dirtyCheck=()=>true;
  // 保存 / 归档 / 删除是用户显式动作：要允许它们打开预览或切换对象（未保存保护只拦"默默关掉"）。
  let allowNavigate=false;
  if(!modal.present(request,{title:existing?'编辑'+labels[kind]:'新建'+labels[kind],type:labels[kind],html,beforeClose:()=>dirtyCheck()}))return null;
  const body=document.querySelector('#detailbody');
  wireSelects(body,{document});
  wireRefCreate(body,{kind,notify,batch});
  // 先把已有值写进 hidden input，再让 VI 选择控件把显示文本同步过来（原生控件不需要这一步）。
  for(const field of body.querySelectorAll('[data-field]'))if(field.dataset.field in data)field.value=field.dataset.field==='evidence'&&Array.isArray(data.evidence)?data.evidence.map(e=>e.quote).join('\n'):(data[field.dataset.field]??'');
  // 推翻理由不是对象上的字段，而是 overturnedBy.reason（宪章三：推翻要留痕）。
  // 编辑一条已被推翻的判断时，把它回填出来，否则用户会以为"推翻理由丢了"。
  {const reason=body.querySelector('[data-field="overturnReason"]');if(reason&&typeof data.overturnedBy?.reason==='string')reason.value=data.overturnedBy.reason}
  for(const wrapper of body.querySelectorAll('[data-viselect]')){
   const input=wrapper.querySelector('input[type="hidden"]'),text=wrapper.querySelector('[data-viselect-text]');
   const option=[...wrapper.querySelectorAll('[data-viselect-option]')].find(node=>node.dataset.viselectOption===input.value);
   if(option){text.textContent=option.textContent;for(const node of wrapper.querySelectorAll('[data-viselect-option]'))node.setAttribute('aria-selected',String(node===option))}
  }
  // 多值引用字段（依赖任务 / 参与人）：初始值渲染成可移除的标签，取值时还原成数组。
  for(const hidden of body.querySelectorAll('input[data-refmulti]')){
   const field=hidden.dataset.field;
   const names=new Map([...body.querySelectorAll('[data-viselect-option]')].map(node=>[node.dataset.viselectOption,node.textContent]));
   const chips=body.querySelector('[data-refchips="'+field+'"]');
   const initial=Array.isArray(data[field])?data[field]:[];
   hidden.value=initial.join(',');
   for(const id of initial){
    const chip=document.createElement('span');chip.className='refchip';
    chip.textContent=names.get(id)??id;
    const remove=document.createElement('button');remove.type='button';remove.className='refchip-remove';remove.setAttribute('aria-label','移除');
    remove.onclick=()=>{hidden.value=hidden.value.split(',').filter(item=>item&&item!==id).join(',');chip.remove()};
    chip.append(remove);chips?.append(chip);
   }
   // 添加下拉：选中就加一个标签，并把这个选项从下拉里去掉（避免重复添加）
   const wrapper=[...body.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input[type="hidden"]')?.dataset.field===field+'-add');
   const input=wrapper?.querySelector('input[type="hidden"]');
   if(wrapper&&input){
    input.addEventListener('change',()=>{
     const id=input.value;if(!id)return;
     const list=hidden.value.split(',').filter(Boolean);
     if(!list.includes(id)){list.push(id);hidden.value=list.join(',');
      const chip=document.createElement('span');chip.className='refchip';chip.textContent=names.get(id)??id;
      const remove=document.createElement('button');remove.type='button';remove.className='refchip-remove';remove.setAttribute('aria-label','移除');
      remove.onclick=()=>{hidden.value=hidden.value.split(',').filter(item=>item&&item!==id).join(',');chip.remove()};
      chip.append(remove);chips?.append(chip);
     }
     input.value='';
     const text=wrapper.querySelector('[data-viselect-text]');if(text)text.textContent='添加';
    });
   }
  }
  const rows=[];
  /** 交付项/步骤改成**两行式**条目：第一行 勾选 + 名称 + 删除；第二行 日期 + 负责人选择器 + 状态选择器。
   *  一行最多 3 个控件（A3 量化验收线），不再把 6 个控件挤成一行、也不再让用户手填负责人 ID 或手写状态。 */
  function addItem(value){
   const id=value?.id??globalThis.crypto.randomUUID();
   const row=document.createElement('div');row.className='itemrow';row.dataset.deliverable='1';
   const line1=document.createElement('div');line1.className='itemline';
   const done=document.createElement('input');done.type='checkbox';done.checked=value?.done===true;done.dataset.role='done';done.setAttribute('aria-label','已完成');
   const title=document.createElement('input');title.value=value?.title??'';title.dataset.role='itemtitle';title.placeholder='条目名称';
   const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.dataset.role='itemremove';remove.textContent='删除';
   line1.append(done,title,remove);
   const line2=document.createElement('div');line2.className='itemline';
   const due=document.createElement('input');due.type='date';due.value=value?.dueDate??'';due.dataset.role='itemdue';due.setAttribute('aria-label','截止日期');
   const ownerWrap=document.createElement('div');ownerWrap.className='itemsel';
   ownerWrap.innerHTML=selectHtml({name:'itemowner',attribute:'data-role',value:value?.ownerId??'',options:[['','负责人未指定'],...(refOptions.person??[])],placeholder:'负责人未指定',id:'itemowner-'+id});
   const statusWrap=document.createElement('div');statusWrap.className='itemsel';
   statusWrap.innerHTML=selectHtml({name:'itemstatus',attribute:'data-role',value:value?.status??'',options:[['','状态未设置'],['todo','待办'],['doing','进行中'],['done','已完成'],['blocked','受阻']],placeholder:'状态未设置',id:'itemstatus-'+id});
   line2.append(due,ownerWrap,statusWrap);
   // 交付项可以标阶段：放在第三行，保证每一行仍然不超过 3 个控件（A3 的量化线不变）。
   const line3=document.createElement('div');line3.className='itemline';
   const stageWrap=document.createElement('div');stageWrap.className='itemsel';
   stageWrap.innerHTML=selectHtml({name:'itemstage',attribute:'data-role',value:value?.stage??'',options:[['','阶段未设置'],...stageOptions],placeholder:'阶段未设置',id:'itemstage-'+id});
   line3.append(stageWrap);
   const owner=ownerWrap.querySelector('input[type="hidden"]'),status=statusWrap.querySelector('input[type="hidden"]'),stage=stageWrap.querySelector('input[type="hidden"]');
   const entry={id,done,title,due,owner,status,stage};rows.push(entry);
   remove.onclick=()=>{entry.removed=true;row.remove()};
   row.append(line1,line2,line3);body.querySelector('#objchecklist').append(row);
  }
  for(const value of (kind==='project'?data.deliverables:data.steps)??[])addItem(value);
  // 行是后加的，VI 选择控件要在这里再接线一次（对话框打开时还没有这些行）。
  const checklistRoot=body.querySelector('#objchecklist');
  if(checklistRoot)wireSelects(checklistRoot,{document});
  const addButton=body.querySelector('#objadditem');if(addButton)addButton.onclick=()=>{addItem();const added=checklistRoot?.lastElementChild;if(added)wireSelects(added,{document})};
  // 项目文件夹：全站唯一的目录浏览器（根目录起点 / 面包屑 / 上级 / 回根 / 选这个文件夹）。
  // 旧实现从**非法存量值**开始、失败后直接 return 留下空白面板、进入空目录后无法选当前目录 —— 46 号审计实测必失败。
  const folderButton=body.querySelector('[data-folderpick]');
  let folderBrowser=null;
  const closeFolderPanel=()=>{const panel=body.querySelector('[data-folderpanel]');if(panel){panel.hidden=true;panel.replaceChildren()}folderBrowser?.dispose();folderBrowser=null};
  if(folderButton)folderButton.onclick=()=>{
   const input=body.querySelector('[data-field="folder"]'),panel=body.querySelector('[data-folderpanel]');
   if(!input||!panel)return;
   if(!panel.hidden){closeFolderPanel();return}
   panel.hidden=false;
   const fieldTitle=()=>String(body.querySelector('[data-field="title"]')?.value||existing?.data?.title||'').trim();
   folderBrowser=mountDirectoryBrowser(panel,{
    document,send,notify,initialPath:input.value,title:fieldTitle(),selectLabel:'选这个文件夹',
    onSelect:selected=>{if(!selected)return;input.value=selected;closeFolderPanel();notify('已选择文件夹：'+selected)}
   });
  };
  // 名称改了以后，候选匹配用的是最新名称（打开面板时才读一次，避免每敲一个字都扫目录）。
  body.querySelector('[data-field="title"]')?.addEventListener('change',()=>folderBrowser?.setTitle(String(body.querySelector('[data-field="title"]')?.value??'')));
  {
   const signature=()=>JSON.stringify([...body.querySelectorAll('[data-field]')].map(field=>[field.dataset.field,field.type==='checkbox'?field.checked:field.value]))
     +JSON.stringify([...body.querySelectorAll('#objchecklist input[type="checkbox"]')].map(box=>box.checked));
   const initial=signature();
   let warned=false,bar=null;
   const clearBar=()=>{bar?.remove();bar=null};
   const showBar=()=>{
    if(bar)return;
    bar=document.createElement('div');bar.className='notice';bar.dataset.unsaved='1';
    bar.textContent='改了还没保存。继续编辑，或者放弃这次修改。';
    const keep=document.createElement('button');keep.type='button';keep.className='btn';keep.dataset.unsavedKeep='1';keep.textContent='继续编辑';
    keep.onclick=()=>{warned=false;clearBar()};
    const drop=document.createElement('button');drop.type='button';drop.className='btn';drop.dataset.unsavedDrop='1';drop.textContent='放弃修改';
    drop.onclick=()=>{warned=true;clearBar();modal.close()};
    bar.append(keep,drop);
    const actions=body.querySelector('.modalactions');if(actions)actions.before(bar);else body.append(bar);
   };
   body.addEventListener('input',()=>{warned=false;clearBar()});
   body.addEventListener('change',()=>{warned=false;clearBar()});
   dirtyCheck=()=>{if(allowNavigate||signature()===initial||warned)return true;warned=true;showBar();return false};
  }
  wire('#objcancel',()=>modal.close());
  if(existing)wire('#objarchive',()=>{allowNavigate=true;return batch.draft('归档 '+existing.data.title,[{op:'archive',id:existing.id,expectedRevision:existing.revision}]).catch(error=>notify(error.message,true))});
  // 删除是破坏性操作：先说明"删了会影响谁"，再让用户确认（引用检查在服务端还会再拦一次）。
  if(existing)wire('#objdelete',async()=>{allowNavigate=true;
   const preview=await send('preview',{id:(await batch.draft('删除 '+existing.data.title,[{op:'delete',id:existing.id,expectedRevision:existing.revision}])).id});
   const refs=preview.references??[];
   if(refs.length){
    notify('不能删除：「'+existing.data.title+'」仍被 '+refs.length+' 个对象引用：'+refs.slice(0,3).map(ref=>ref.title+'（'+ref.field+'）').join('、')+'。请先解除引用，或改为归档。',true);
    return;
   }
   notify('已生成待确认的删除，同意后才会真正删除');
  });
  wire('#objpreview',async()=>{allowNavigate=true;
   // Editing starts from the stored data so fields outside this form (tags, sourceRefs, ownerId…) survive.
   const result=existing?{...existing.data}:{};
   // 判断记录"是谁起草的"：用户在界面里新建的，来源就是「你说的」；
   // AI 起草的由 Agent 通道写成「AI 起草」（见 dsh-adapter）。编辑不改来源。
   if(!existing&&kind==='judgment')result.origin='user';
   for(const field of body.querySelectorAll('[data-field]')){
    const name=field.dataset.field;
    // 判断的依据：用户手写每行一条 → 结构化。kind 固定 note（"你的口述"），
    // 不冒充会话原文/文件引用；需要真实出处时由 Agent 从读到的材料带进来。
    if(name==='evidence'&&kind==='judgment'){
     const lines=field.value.split('\n').map(text=>text.trim()).filter(Boolean);
     // **没动过的行必须原样保留**（2026-10-16 修）：原来这里把每一行都重写成
     // `{kind:'note',ref:'user-said-N'}` —— 于是**只要编辑一次判断，它的文件/录音出处就全丢了**。
     // 而"依据能追回原始出处"是宪章判据 3；一条判断改个标题就把出处弄丢，等于判据 3 从手里漏走。
     // 规则：行内容与原有某条依据的原文一致（且顺序对得上）→ 沿用原来那条（kind/ref/verified 全保留）；
     //       用户新写或改过的行 → 按"你的口述"处理（不冒充会话原文/文件引用）。
     const originals=Array.isArray(existing?.data?.evidence)?existing.data.evidence:[];
     const used=new Set();
     const kept=lines.map((quote,index)=>{
      const same=originals.find((row,at)=>!used.has(at)&&String(row.quote??'').trim()===quote);
      if(same){used.add(originals.indexOf(same));return {...same,quote:quote.slice(0,300)}}
      return {kind:'note',ref:'user-said-'+(index+1),quote:quote.slice(0,300),verified:false};
     });
     if(kept.length)result.evidence=kept;
     else delete result.evidence;
     continue;
    }
    // 出处：与依据**按行号一一对应**。填了就让这条依据能真的点回"那一段"。
    if(name==='evidenceRef'&&kind==='judgment'){
     const refs=field.value.split('\n').map(text=>text.trim());
     const list=Array.isArray(result.evidence)?result.evidence:[];
     const AUDIO=/\.(m4a|mp3|wav|aac|ogg|flac)$/i;
     list.forEach((row,index)=>{
      const raw=(refs[index]??'').trim();
      if(!raw)return;
      if(/^https?:\/\//i.test(raw)){row.kind='web';row.ref=raw;return}
      // `名字@120-180`：录音按秒、文件按段（规范 03 §10 的引用锚点形状）
      row.kind=AUDIO.test(raw.split('@')[0])?'audio':'file';
      row.ref=raw.slice(0,500);
     });
     continue;
    }
    // 推翻理由（F9，2026-10-16 修）：判断表单里有「已被推翻」这个状态，却**没有任何地方收推翻理由**，
    // 于是校验必然拦下（"被推翻的判断必须留下推翻依据"）——用户根本做不到"推翻要留痕"。
    // 这里把它组装成 overturnedBy（ref 留空 = 没有新的外部引用，不编一个假锚点）。
    if(name==='overturnReason'&&kind==='judgment'){
     const reason=field.value.trim();
     if(reason)result.overturnedBy={reason:reason.slice(0,300),at:new Date().toISOString()};
     continue;
    }
    if(field.dataset.refmulti==='1'){const list=field.value.split(',').filter(Boolean);if(list.length)result[name]=list;else delete result[name];continue}
    // 事务的开始/结束是**本地时间**（用户按提示填 2026-10-20 10:30），
    // 但校验要求带时区 → 这里统一补上本机时区偏移（toZonedDateTime），否则定时事务根本存不进去。
    const raw=name==='content'?field.value:field.value.trim();
    let value=raw;
    if(['startDate','endDate','dueDate'].includes(name)&&raw){
     // 用户按提示填的是**本地时间**（2026-10-20 10:30）：自动补上本机时区偏移。
     // 补完仍然不合法（例如 2026-13-45 或随手写的字）→ 直接拦下，不生成草稿。
     value=toZonedDateTime(raw);
     if(!validDate(value))throw Error('时间格式无效：'+raw+'（示例：2026-10-20 10:30，或 2026-10-20）');
    }
    if(value)result[name]=value;else if(existing)delete result[name]}
   if(!result.title)throw Error('请填写名称');
   // 状态改回「当前有效 / 待核对」时，推翻留痕要一起撤掉 —— 否则会留下"没被推翻却带着推翻理由"的对象。
   if(kind==='judgment'&&result.status!=='overturned')delete result.overturnedBy;
   if(kind==='project'||kind==='task'){const key=kind==='project'?'deliverables':'steps';const values=rows.filter(row=>!row.removed).map(row=>{
    if(!row.title.value.trim())throw Error('请填写条目名称或删除空条目');
    const item={id:row.id,title:row.title.value.trim(),done:!!row.done.checked};
    // 只写用户真的填了的字段：没填就不写，避免把空值当成"已排期"。
    if(row.due?.value)item.dueDate=row.due.value;
    if(row.owner?.value.trim())item.ownerId=row.owner.value.trim();
    if(row.status?.value.trim())item.status=row.status.value.trim();
    if(row.stage?.value)item.stage=row.stage.value; // 阶段也是"填了才写"，不把空值当成已标阶段
    return item;
   });if(values.length||existing?.data[key])result[key]=values}
   try{validateData(kind,result)}catch(error){notify(error.message,true);return}
   // 项目文件夹：保存前校验目录**真的存在**；不存在就不写库，就地给候选与重新选择（W1 P0-2）。
   if(kind==='project'&&String(result.folder??'').trim()){
    const folder=String(result.folder).trim();
    try{await send('directory_list',{path:folder})}
    catch(error){showFolderFix(humanFolderError(error,folder),folder,result.title);return}
   }
   // PRD v1.2 PJ-06/PJ-08：同名对象先匹配提示，不凭名称自动合并，也不静默创建第二份。
   if(!existing&&!acknowledged&&await warnDuplicate(kind,result.title))return;
   // 「只提交改动字段」（spec/54 D6）：编辑已有对象时，只把真正变了的字段名放进 fields，
   // 其余字段（含别的窗口刚改过的）原样保留；一个字段都没变就不生成空改动。
   const before=existing?.data??{};
   const changedFields=existing?Object.keys(result).filter(key=>JSON.stringify(result[key])!==JSON.stringify(before[key])):[];
   if(existing&&!changedFields.length){notify('没有改动，未生成改动');return}
   const changes=[existing?{op:'update',id:existing.id,expectedRevision:existing.revision,data:result,fields:changedFields}:{op:'create',kind,data:result}];
   // 你自己填的表单：直接生效 + 可撤销（不再让你为自己的操作点同意）。
  const title=(existing?'编辑':'新建')+labels[kind];
  const label=(existing?'已更新 ':'已新建 ')+labels[kind];
  if(typeof batch.apply==='function')await batch.apply(title,changes,{label});
  else await batch.draft(title,changes);   // 兼容只有 draft 的嵌入方
  });

  /** 保存时文件夹不存在：不写库，就地说明 + 给候选 + 重新选择（W1 P0-2）。 */
  function showFolderFix(message,folder,titleForSuggest){
   const field=body.querySelector('[data-folderfield]');
   if(!field)return;
   let fix=body.querySelector('[data-folderfix]');
   if(!fix){fix=document.createElement('div');fix.className='folderfix';fix.dataset.folderFix='1';field.append(fix)}
   fix.hidden=false;fix.replaceChildren();
   const reason=document.createElement('p');reason.className='formhint';reason.dataset.folderFixReason='1';reason.textContent='没保存：'+message+'。';fix.append(reason);
   const looking=document.createElement('p');looking.className='formhint';looking.textContent='正在找相似的文件夹…';fix.append(looking);
   const list=document.createElement('div');list.className='foldercandidates';fix.append(list);
   const actions=document.createElement('div');actions.className='folderactions';
   const reselect=document.createElement('button');reselect.type='button';reselect.className='btn';reselect.dataset.folderFixRetry='1';reselect.textContent='重新选择';
   reselect.onclick=()=>{fix.hidden=true;fix.replaceChildren();folderButton?.click()};
   const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.dataset.folderFixCancel='1';cancel.textContent='取消';
   cancel.onclick=()=>{fix.hidden=true;fix.replaceChildren()};
   actions.append(reselect,cancel);fix.append(actions);
   fix.scrollIntoView?.({block:'nearest'});
   suggestFolders(send,titleForSuggest).then(items=>{
    if(!fix.isConnected||fix.hidden)return;
    looking.remove();
    renderFolderCandidates(list,items,picked=>{
     const input=body.querySelector('[data-field="folder"]');
     if(input)input.value=picked;
     fix.hidden=true;fix.replaceChildren();
     notify('已换成：'+picked+'，再点保存');
    });
   }).catch(()=>{
    looking.remove();
    const hint=document.createElement('p');hint.className='formhint';hint.textContent='读不到候选文件夹；可以点「重新选择」从根目录挑。';list.append(hint);
   });
  }

  async function warnDuplicate(kind,title){
   let matches=[];
   try{const result=await send('node_search',{query:title,limit:20});matches=(result.items??[]).filter(item=>item.kind===kind)}
   catch(error){notify('同名检查未能执行：'+error.message,true);return false}
   if(!matches.length)return false;
   const exact=matches.filter(item=>item.title===title);
   const block=document.createElement('section');
   block.innerHTML=`<p class="notice" data-duplicate>已存在 ${matches.length} 个同类型对象（${exact.length} 个完全同名）：${matches.map(item=>esc(item.title)).join('、')}。工作台不会仅凭名称自动合并，请确认这是不同的对象。</p>`;
   const actions=document.createElement('div');actions.className='modalactions';
   const proceed=document.createElement('button');proceed.className='btn primary';proceed.id='objduplicate';proceed.dataset.duplicateConfirm='';proceed.textContent='确认新建（不同对象）';
   proceed.onclick=async()=>{acknowledged=true;block.remove();actions.remove();await document.querySelector('#objpreview').onclick()};
   actions.append(proceed);
   for(const match of matches.slice(0,5)){
    const open=document.createElement('button');open.className='btn';open.dataset.duplicateOpen=match.id;open.textContent='改为编辑：'+match.title;
    // node_search 只返回摘要；必须读取完整对象，否则保存会以摘要为基底覆盖掉其他字段。
    open.onclick=async()=>{open.disabled=true;try{const {item}=await send('get',{id:match.id});if(!item||item.archived)throw Error('对象已归档或不可用');await dialog(kind,item)}catch(error){notify(error.message,true);open.disabled=false}};
    actions.append(open);
   }
   body.append(block,actions);
   return true;
  }
  return true;
 }
 async function menu(){
  const request=token=modal.begin();if(request===null)return null;
  // 2026-10-14（用户点名「新建后的弹窗里面各个选项没有图标了」）：
  // 原型里 `.resource` 本来是**图标 + 标题 + 一行说明**，实现时把图标丢了、九张卡片还共用同一句
  // 「填完保存即生效，可随时撤销。」——既没有识别度，也没有告诉人该建哪个。
  // 现在：每个类型一个登记在册的 VI 图标（新增 person / organization）+ 各写一句**不同**的用处，
  // 并按「工作推进 / 积累 / 谁参与」三组分开（VI §5 图标在册 + §6 组件唯一）。
  // 顶栏原来有两个入口：「录入」和「新建」。它们语义不同（材料进来 vs 自己建），
  // 但界面重复 —— 品味「克制：新元素必须证明无法被现有元素表达」。
  // 现在只留「新建」一个入口，把"从材料进来"作为菜单的第一节（仍是同一条写入路径）。
  const intakeEntry=onIntake?`<section class="menugroup"><h3>从材料进来</h3><div class="resourcegrid"><button class="surface resource" data-intakeentry="1"><svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg><h2>粘贴 / 文件 / 链接</h2><p>把外面的材料搬进来，先进收件箱等你确认</p></button></div></section>`:'';
  const html=intakeEntry+menuGroups().map(group=>`<section class="menugroup"><h3>${esc(group.title)}</h3><div class="resourcegrid">${group.items.map(([kind,icon,label,desc])=>`<button class="surface resource" data-kind="${esc(kind)}"><svg class="icon" aria-hidden="true"><use href="#i-${esc(icon)}"/></svg><h2>${esc(label)}</h2><p>${esc(desc)}</p></button>`).join('')}</div></section>`).join('')
   +'<p class="notice">你自己新建的记录保存后立刻生效，顶部会给一条「已保存 · 撤销」。</p><div class="modalactions"><button class="btn" id="createclose">关闭</button></div>';
  if(!modal.present(request,{title:'新建',type:'工作台',html}))return null;
  for(const node of document.querySelectorAll('#detailbody [data-kind]'))node.onclick=()=>dialog(node.dataset.kind).catch(error=>notify(error.message,true));
  {const entry=document.querySelector('#detailbody [data-intakeentry]');if(entry)entry.onclick=()=>{modal.close();onIntake()}}
  const close=document.querySelector('#detailbody #createclose');if(close)close.onclick=()=>modal.close();
  return true;
 }
 return {menu,open:(kind,existing,preset)=>dialog(kind,existing,preset),dispose(){modal.invalidate(token)}};
}
