import {projectRoadmap} from './project-roadmap.mjs';
import {readProjectModels} from './project-data.mjs';
import {renderProjectStrip,escapeHtml} from './project-render.mjs';
import {showEmpty,emptyState} from './empty-state.mjs';
import {sortByPriority,priorityLabels,projectModels} from './project-data.mjs';
import {selectHtml,wireSelects} from './vi-select.mjs';

/** ── 全站唯一的「筛选」控件（VI §6「同一控件全站唯一实现」／审计 P2 #19）────────────
 *  收件箱、项目、任务三处此前各写一套：收件箱是「按钮 + 常驻状态片 + 收起面板（3 个下拉）」，
 *  项目是「按钮 + 7 个下拉」，任务是「一排常驻筛选，连按钮都没有」。同一个能力三种长相，
 *  用户每换一页都要重新认一遍控件。
 *
 *  现在三处共用这一份实现：工具栏上只有一个「筛选」按钮，条件全部收进面板；面板里两个插槽 ——
 *  状态片行（色点 + 文字）与下拉字段行，用同一套类、同一套间距、同一套选中与焦点态；
 *  **有几条筛选生效，就写在按钮上**（「筛选 · 2」）—— 诚实要求：不能让人看着一份被过滤过的
 *  列表却不知道（VI §7 状态语言）。默认收起是品味「克制」：7 个筛选器常驻要占两行、吃掉首屏约 1/5。
 *
 *  为什么共用实现住在这个文件里：发布清单是一张固定表（prototype/build-v7.mjs 的 plan），
 *  新开一个模块进不了产物，改那张表不在本次改动范围内。所以共用实现跟着它的参考实现
 *  （项目页原来的 #projectfiltertoggle）走，另两处 import 同一份，不复制代码。
 *
 *  chips 的 state 用状态点那一套词（draft / conflict / committed / cancelled）：与卡片状态点
 *  .statusdot 共用同一张 data-state 变量表（VI §2：颜色只做辅助，判断始终由文字承担）。
 */
export function filterBarHtml({id,toggleId=id+'toggle',chips=[],chipAttribute='data-filterchip',chipValue='',fields=[],open=false}){
 const chip=item=>{
  const on=String(item.value??'')===String(chipValue??'');
  const dot=item.state?`<i class="fdot" data-state="${escapeHtml(item.state)}" aria-hidden="true"></i>`:'';
  return `<button type="button" class="filterchip${on?' active':''}" ${chipAttribute}="${escapeHtml(item.value??'')}" aria-pressed="${on?'true':'false'}">${dot}${escapeHtml(item.label)}</button>`;
 };
 const statusRow=chips.length?`<div class="seg filterstatus" role="group" aria-label="按状态筛选">${chips.map(chip).join('')}</div>`:'';
 const fieldRow=fields.length?`<div class="filterfields">${fields.map(html=>`<div class="filterfield">${html}</div>`).join('')}</div>`:'';
 return `<button type="button" class="btn filtertoggle" id="${toggleId}" aria-expanded="${open?'true':'false'}" aria-controls="${id}">筛选</button>`
  +`<div class="filterpanel" id="${id}"${open?'':' hidden'}>${statusRow}${fieldRow}</div>`;
}

/** 给「筛选」控件接线：展开 / 收起、按钮上写出生效条数、状态片的选中态。
 *  哪些条件算"生效"由各视图声明（counted 列出计入的键，defaults 是默认值）；
 *  筛选**怎么算**仍是各页自己的业务（onchange 在调用方），共用的只有控件形态与这一个口径。 */
export function wireFilterBar(root,{id,toggleId=id+'toggle',state={},counted=[],defaults={},chips=null,onToggle}={}){
 const toggle=root?.querySelector('#'+toggleId),panel=root?.querySelector('#'+id);
 if(!toggle||!panel)return null;
 // 默认值可以是数组：「这些都算默认视图」（收件箱的「待确认」是默认视图，「全部」等于没筛）。
 const count=()=>counted.filter(key=>{
  const value=String(state[key]??'');
  const fallback=defaults[key];
  return Array.isArray(fallback)?!fallback.map(String).includes(value):value!==String(fallback??'');
 }).length;
 const sync=()=>{
  const total=count();
  toggle.textContent=total?'筛选 · '+total:'筛选';
  toggle.dataset.active=total?'1':'0';
  toggle.setAttribute('aria-expanded',String(!panel.hidden));
  if(chips)for(const chip of panel.querySelectorAll('['+chips.attribute+']')){
   const on=String(chip.getAttribute(chips.attribute)??'')===String(state[chips.key]??'');
   chip.classList.toggle('active',on);
   chip.setAttribute('aria-pressed',String(on));
  }
 };
 toggle.onclick=()=>{panel.hidden=!panel.hidden;sync();if(typeof onToggle==='function')onToggle(!panel.hidden)};
 sync();
 return {toggle,panel,sync,count};
}

/** 项目筛选：按阶段 / 机构 / 负责人 / 重要度 / 紧急度 / 交付状态筛，默认按优先级排序。
 *  外壳里没有筛选容器（只有两个模式页签），所以按已批准的做法在运行时注入。
 *  选项全部来自真实记录，不造枚举；筛选不出结果时如实说"当前筛选没有项目"。 */
function mountFilters(document,send){
 const tabs=document.querySelector('#projecttabs');
 if(!tabs||document.querySelector('#projectfilters'))return null;
 // 上一轮可能只剩下一枚孤立的「筛选」按钮（dispose 只摘面板的那条老路），先清干净再挂新的。
 document.querySelector('#projectfiltertoggle')?.remove();
 const organizations=[],persons=[];
 const state={stage:'',partnerId:'',ownerId:'',importance:'',urgency:'',delivery:'',sort:'priority'};
 const holder=document.createElement('div');
 holder.innerHTML=filterBarHtml({id:'projectfilters',toggleId:'projectfiltertoggle',fields:[
  selectHtml({name:'stage',attribute:'data-pfilter',label:'阶段',value:'',placeholder:'全部阶段',options:[['','全部阶段'],['接触','接触'],['需求','需求'],['方案','方案'],['验证','验证'],['复盘','复盘']].filter((item,index,list)=>list.findIndex(other=>other[0]===item[0])===index)}),
  selectHtml({name:'partnerId',attribute:'data-pfilter',label:'合作机构',value:'',placeholder:'全部机构',options:[['','全部机构'],...organizations]}),
  selectHtml({name:'ownerId',attribute:'data-pfilter',label:'负责人',value:'',placeholder:'全部负责人',options:[['','全部负责人'],...persons]}),
  selectHtml({name:'importance',attribute:'data-pfilter',label:'重要程度',value:'',placeholder:'全部',options:[['','全部'],['high','高'],['medium','中'],['low','低'],['none','未设置']]}),
  selectHtml({name:'urgency',attribute:'data-pfilter',label:'紧急程度',value:'',placeholder:'全部',options:[['','全部'],['high','高'],['medium','中'],['low','低'],['none','未设置']]}),
  selectHtml({name:'delivery',attribute:'data-pfilter',label:'交付状态',value:'',placeholder:'全部',options:[['','全部'],['late','有逾期'],['dated','已排期'],['undated','未排期'],['done','已全部完成']]}),
  selectHtml({name:'sort',attribute:'data-pfilter',label:'排序',value:'priority',placeholder:'优先级',options:[['priority','优先级（重要×紧急）'],['due','计划截止'],['name','名称']]}),
 ]});
 const [toggle,box]=[...holder.children];
 box.dataset.filters='1';
 tabs.after(toggle,box);
 // counted 里没有 sort：怎么排只改顺序、不隐藏任何东西，不算"一条筛选"。
 const bar=wireFilterBar(tabs.parentElement,{id:'projectfilters',toggleId:'projectfiltertoggle',state,counted:['stage','partnerId','ownerId','importance','urgency','delivery'],defaults:{stage:'',partnerId:'',ownerId:'',importance:'',urgency:'',delivery:''}});
 // 事件构造器取**本页**的：在 jsdom 里 Node 的全局 CustomEvent 不是这个文档的 Event，
 // dispatchEvent 会直接抛 TypeError（测试里这条路径一直是断的）。
 const fire=()=>document.dispatchEvent(new (document.defaultView?.CustomEvent??CustomEvent)('project-filters',{detail:{...state}}));
 box.addEventListener('change',()=>bar?.sync());
 wireSelects(box,{document});
 // 机构与负责人的下拉来自真实记录；读不到就保持"全部"，不编造选项。
 void (async()=>{
  for(const [name,kind] of [['partnerId','organization'],['ownerId','person']]){
   try{
    const {items=[]}=await send('list',{kind,limit:200});
    const wrapper=[...box.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input')?.dataset.pfilter===name);
    const list=wrapper?.querySelector('[data-viselect-list]');
    if(!list)continue;
    for(const item of items.filter(x=>!x.archived)){
     const option=document.createElement('button');
     option.type='button';option.className='viselect-option';option.setAttribute('role','option');
     option.dataset.viselectOption=item.id;option.setAttribute('aria-selected','false');
     option.textContent=item.data?.title||item.id;
     option.onclick=()=>{
      const input=wrapper.querySelector('input[type="hidden"]');
      input.value=item.id;
      wrapper.querySelector('[data-viselect-text]').textContent=option.textContent;
      for(const node of list.querySelectorAll('[data-viselect-option]'))node.setAttribute('aria-selected',String(node===option));
      list.hidden=true;wrapper.querySelector('[data-viselect-button]').setAttribute('aria-expanded','false');
      state[name]=item.id;
      // 机构 / 负责人是从浮层列表里选的，不走 change 事件：条数必须在这里同步一次，
      // 否则按钮上会少算一条（原来就是这里漏了，选完机构和没筛一样）。
      bar?.sync();
      fire();
     };
     list.append(option);
    }
   }catch{/* 读不到就只保留"全部" */}
  }
 })();
 // 用 onchange 属性而不是 addEventListener：插件的逐控件审计按属性判定"是否接线"，
 // 保持它的严格判定（否则要么放水，要么这里出现假阴性）。
 for(const input of box.querySelectorAll('[data-pfilter]'))input.onchange=()=>{
  state[input.dataset.pfilter]=input.value;
  bar?.sync();
  fire();
 };
 return {state,box,bar};
}

/** 应用筛选 + 默认排序。 */
export function applyProjectFilters(projects,state){
 const filtered=projects.filter(project=>{
  if(state.stage&&project.stageLabel!==(state.stage||'待规划')&&(project.stageRaw??project.stageLabel)!==state.stage)return false;
  if(state.partnerId&&project.partnerId!==state.partnerId)return false;
  if(state.ownerId&&project.ownerId!==state.ownerId)return false;
  if(state.importance==='none'&&project.importance)return false;
  if(state.importance&&state.importance!=='none'&&project.importance!==state.importance)return false;
  if(state.urgency==='none'&&project.urgency)return false;
  if(state.urgency&&state.urgency!=='none'&&project.urgency!==state.urgency)return false;
  if(state.delivery==='late'&&!project.lateCount)return false;
  if(state.delivery==='dated'&&!project.hasDates)return false;
  if(state.delivery==='undated'&&project.hasDates)return false;
  if(state.delivery==='done'&&!(project.total&&project.done===project.total))return false;
  return true;
 });
 if(state.sort==='due')return [...filtered].sort((a,b)=>String(a.dueDate??'9999').localeCompare(String(b.dueDate??'9999')));
 if(state.sort==='name')return [...filtered].sort((a,b)=>String(a.name).localeCompare(String(b.name),'zh'));
 return sortByPriority(filtered);
}
/** ── 名册（项目页第三种看法：项目组合 ｜ 时间路线图 ｜ 名册）2026-10-15 ────────────────
 *  用户否掉了"列表放关联空间"那个位置（原话：「不对，不是在关联空间做列表，是在项目模块做，
 *  不然关联空间太乱了」）—— 关联空间回到纯画布，这份"分组 + 行"的看法搬到项目页当一个页签。
 *
 *  为什么不做成表格：表头 + 纵向网格线是另一种视觉语言（会被读成"数据表"）。本产品的分层只用
 *  对齐、间距、字重与雾线（VI §4 / V4「不靠框与色块堆叠」），所以这里是**分组 + 行**：
 *  每组一个小标题，行与行之间一条雾线，行本身就是详情入口（沿用画布单击节点那条通路）。 */
export const rosterGroupTitles={project:'项目',organization:'组织',person:'负责人'};
// 行的图标用 <use href="#i-…"> 拼 SVG，命名空间必须显式给（SVG 不是 HTML 命名空间）。
const ns='http://www.w3.org/2000/svg';

/** 项目一行的关键信息：阶段 + 交付进度。
 *  口径**共用项目页**（project-data.mjs 的 projectModels），这里只把「未设置」翻成名册里更短的
 *  「未记录」，不另算一遍进度 —— 同一件事两套算法迟早会给出两个数字。 */
export function projectListInfo(model){
 const stage=model?.stageLabel&&model.stageLabel!=='阶段未设置'?model.stageLabel:'';
 const progress=model?.total?'交付 '+model.progressLabel+' 项':'交付项未记录';
 return (stage?'阶段：'+stage:'阶段未记录')+' · '+progress;
}
/** 组织一行的关键信息：关联的项目数。项目清单没读到就说没读到，不拿 0 冒充"没有关联项目"。 */
export function organizationListInfo(organization,projects,{projectsRead=true}={}){
 if(!projectsRead)return '关联项目数未记录';
 const linked=projects.filter(project=>project?.data?.partnerId===organization.id).length;
 return linked?'关联 '+linked+' 个项目':'还没有关联项目';
}
/** 负责人一行的关键信息：负责的项目 / 任务数。哪一半读不到就写哪一半未记录。 */
export function personListInfo(person,projects,tasks,{projectsRead=true,tasksRead=true}={}){
 const owned=projects.filter(project=>project?.data?.ownerId===person.id).length;
 const assigned=tasks.filter(task=>task?.data?.ownerId===person.id).length;
 if(projectsRead&&tasksRead&&!owned&&!assigned)return '还没有负责的项目或任务';
 const parts=[projectsRead?(owned?'负责 '+owned+' 个项目':'没有负责的项目'):'负责的项目数未记录'];
 parts.push(tasksRead?(assigned?assigned+' 个任务':'没有负责的任务'):'任务数未记录');
 return parts.join(' · ');
}
/** 每一行的图标：与画布节点同一套语义（项目蓝、组织与负责人灰，VI §9）。
 *  写在这张表里而不是问 space-view 要：名册已经在项目页，不该为了一个图标把画布那一页拉进来。 */
const rosterIconOf=kind=>({project:'project',organization:'cloud',person:'link'}[kind]||'project');

/** 三类对象的名册读数（纯函数，便于单测）。
 *  读到什么写什么：某一类读不到就把 read 标成 false（界面如实写「读不到」+ 原因），
 *  绝不拿空数组冒充「这一类一个都没有」。
 *  projects 收的是**已经算好的 projectModels**（与项目页同一套算法，不在这里重算一遍）。 */
export function rosterGroups({projects=[],organizations=[],persons=[],tasks=[],reads={}}={}){
 const state=kind=>reads[kind]??{ok:true,reason:''};
 const models=new Map(projects.map(model=>[model.id,model]));
 const records=projects.map(model=>({id:model.id,data:{partnerId:model.partnerId,ownerId:model.ownerId}}));
 const projectsRead=state('project').ok,canReadTasks=state('task').ok;
 const group=(kind,items,{name,info})=>{
  // 每一类的行都只在**这一类读到了**的时候才生成：读不到就没有行，只有一句「读不到 + 原因」。
  const {ok,reason,capped}=state(kind);
  return {kind,title:rosterGroupTitles[kind],read:ok,reason:reason||'',capped:Boolean(capped),
   rows:ok?items.map(item=>({id:item.id,kind,icon:rosterIconOf(kind),title:name(item)||'未命名',info:info(item)})):[]};
 };
 return [
  group('project',projects,{name:model=>model.name,info:model=>projectListInfo(models.get(model.id))}),
  group('organization',organizations,{name:item=>item.data?.title,info:item=>organizationListInfo(item,records,{projectsRead})}),
  group('person',persons,{name:item=>item.data?.title,info:item=>personListInfo(item,records,tasks,{projectsRead,tasksRead:canReadTasks})}),
 ];
}
/** 名册要不要给空态：三类都读到了、且一个对象都没有时才是"真的空"。
 *  读失败时给空态等于骗人（"还没有对象"和"没读到"是两件事，宪章六 诚实）。 */
export function rosterEmpty(groups){return groups.every(group=>group.read)&&groups.every(group=>!group.rows.length)}
/** 按名称即时筛选（**纯前端**：数据已经读进来了，不为每一次敲键再发一次请求）。
 *  匹配的是名称，不是那说明行 —— 搜「验证」不该把"阶段：验证"的项目全都捞出来，
 *  那会让人以为搜的是内容（宪章六 诚实）。大小写与前后空格不算差异。 */
export function filterRosterGroups(groups,query){
 const needle=String(query??'').trim().toLowerCase();
 if(!needle)return groups;
 return groups
  .map(group=>({...group,rows:group.rows.filter(row=>row.title.toLowerCase().includes(needle))}))
  // 某组被筛空 → 整组不显示（留一个空组只会让人以为是没读到）。
  .filter(group=>!group.read||group.rows.length);
}
/** 三组都被筛空时说清楚是"搜索造成的" —— 用户 2026-10-12 的教训：筛空必须说清是哪个筛选。
 *  没有搜索就是真的空；两种情况都给简笔画 + 一句状态 + 一个下一步（VI §6）。
 *  没有新建通路时就不给按钮：做不到的按钮比没有按钮更坏（VI §7 未接入 / 宪章六 诚实）。 */
export function rosterEmptyState(document,{query='',onCreate}={}){
 const search=String(query??'').trim();
 const clear={label:'清空搜索',run:()=>{const input=document.querySelector('[data-roster-search]');if(!input)return;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))}};
 if(search)return emptyState(document,{illustration:'connections',title:'没有匹配「'+search+'」的对象',description:'搜索只按名称匹配项目、组织与负责人；换一个词，或清空搜索看全部。',action:clear});
 if(onCreate)return emptyState(document,{illustration:'connections',title:'还没有可以列出的对象',description:'创建项目、组织或负责人之后，这里会按这三类逐一列出；点一行就能打开它的详情。',action:{label:'新建项目',run:onCreate}});
 return emptyState(document,{illustration:'connections',title:'还没有可以列出的对象',description:'创建项目、组织或负责人之后，这里会按这三类逐一列出；点一行就能打开它的详情。'});
}

/** 项目页第三段（名册）：三组对象 + 顶部一个**只做前端过滤**的搜索框。
 *  数据**按需读**：不切到名册就不发 list 请求；读到的东西在本次挂载内复用，
 *  所以来回切页签、每敲一个字都不会再发请求（用户 2026-10-15：过滤必须是纯前端的）。 */
function createProjectRoster(document,{onOpen,readLists,projects=[],onCreate}={}){
 const view=document.querySelector('#projects');
 const tabs=document.querySelector('#projecttabs');
 const anchor=document.querySelector('#projectsbody');
 if(!view||!tabs||!anchor)return null;
 anchor.querySelector('[data-pane="roster"]')?.remove();   // 上一轮的残留（dispose 已经摘过一次）
 const bar=document.createElement('div');
 bar.className='rosterbar';
 bar.innerHTML='<label class="rosterfield"><svg class="icon" aria-hidden="true"><use href="#i-search"/></svg><input type="search" data-roster-search aria-label="按名称搜索项目、组织与负责人" placeholder="按名称搜索" autocomplete="off"></label>';
 const search=bar.querySelector('input');
 // 搜索框在 <label> 里，Enter 会触发**隐式提交**并"点击"文档里第一个按钮 —— 实测那就是第一行，
 // 于是"打几个字按回车"会顺手打开一个你没选的对象的详情。搜索没有需要提交的东西，直接拦掉。
 search.onkeydown=event=>{if(event.key==='Enter')event.preventDefault()};
 const panel=document.createElement('section');
 panel.className='projectroster';panel.dataset.pane='roster';panel.hidden=true;panel.append(bar);
 anchor.after(panel);
 let mode='portfolio',reads=null,run=null,timer=null,disposed=false,pageHidden=false,lastPainting=null;
 const noteLine=text=>{const line=document.createElement('p');line.className='notice';line.textContent=text;return line};
 const searchText=()=>search.value||'';
 /** 读名册要的三类对象（外加任务：只为了给负责人算"负责几个任务"）。
  *  读不到就把原因原样带回来（界面上如实写「读不到」+ 原因），绝不拿空数组冒充"一个都没有"。
  *  **一次分页读全，再按 kind 自己分**：请求里虽然带着 kind，但不能指望每个实现都照办
  *  （宿主的读取通道把 list 当"按偏移切片"用，kind 会被忽略）。不自己分，
  *  资料 / 任务 / 事务就会混进名册 —— 实测点了它们只会弹「项目已归档或不可用」。 */
 function readAll(){
  if(run)return run;
  const readKind=async kind=>{
   const items=[];let offset=0,capped=false;
   try{
    for(;;){
     const page=await readLists(kind,offset);
     if(!Array.isArray(page?.items))throw Error('返回内容无法识别');
     items.push(...page.items.filter(item=>item&&!item.archived&&item.kind===kind));
     // 空页必须停：忽略 kind 的实现会一直返回整页，不判空就会一路读到上限。
     if(!page.items.length||page.items.length<200)break;
     offset+=200;
     if(items.length>=200||offset>=1000){capped=items.length>=200;break}
    }
    return {ok:true,reason:'',items,capped};
   }catch(error){return {ok:false,reason:error?.message||'原因未记录',items:[],capped:false}}
  };
  run=(async()=>{
   const [organization,person]=await Promise.all(['organization','person'].map(readKind));
   // 一个联系人都没有的时候，"负责几个任务"没有归属，多读一次任务纯属浪费。
   const task=person.items.length?await readKind('task'):{ok:true,reason:'',items:[],capped:false};
   return {organization,person,task};
  })();
  return run;
 }
 function paint(){
  if(disposed)return;
  panel.replaceChildren(bar);
  const typed=searchText();
  panel.dataset.query=typed;
  search.setAttribute('aria-label',typed?'按名称搜索项目、组织与负责人（正在筛选：'+typed+'）':'按名称搜索项目、组织与负责人');
  if(!reads){panel.append(noteLine('正在读取…'));lastPainting=typed;return}
  // 项目用**页面上已经算好的那一份 projectModels**（同一个对象），这里不再算一遍。
  const groups=rosterGroups({projects,organizations:reads.organization.items,persons:reads.person.items,tasks:reads.task.items,reads:{
   project:{ok:true},
   organization:{ok:reads.organization.ok,reason:reads.organization.reason},
   person:{ok:reads.person.ok,reason:reads.person.reason},
   task:{ok:reads.task.ok,reason:reads.task.reason}}});
  const query=searchText();
  const visible=filterRosterGroups(groups,query);
  // 一行都没有可显示的（三组都被筛空，或者本来就没有对象）：说清是搜索造成的，还是真的一个都没有。
  // 判据是**有没有行**，不是"还剩几组" —— 一个对象都没有的时候三组都还在，但每一组都是空的。
  // 读失败时不走这里 —— 那时 visible 里留着"读不到 + 原因"的那几组，空态会把人骗过去。
  if(!visible.some(group=>group.rows.length)&&(query||rosterEmpty(groups))){panel.append(rosterEmptyState(document,{query,onCreate}));lastPainting=query;return}
  for(const group of visible){
   const section=document.createElement('section');
   // data-groupcount：这一组的小标题就是它下面那些行的计数（门禁 D8：分组计数不算"点不动的数字"）。
   section.className='rostergroup';section.dataset.groupcount=group.kind;
   const heading=document.createElement('h3');
   heading.textContent=group.title+' · '+(group.read?group.rows.length+' 个'+(group.capped?'以上':''):'没读到');
   section.append(heading);
   if(!group.read){section.append(noteLine('读不到'+group.title+'：'+group.reason));panel.append(section);continue}
   if(group.capped)section.append(noteLine('只列出前 '+group.rows.length+' 个，其余没有显示。'));
   const rows=document.createElement('div');rows.className='rosterrows';
   for(const row of group.rows){
    const button=document.createElement('button');
    button.type='button';button.className='rosterrow';button.dataset.id=row.id;button.dataset.kind=row.kind;
    button.setAttribute('aria-label',row.title+'：'+row.info+'。打开详情');
    const symbol=document.createElement('span');symbol.className='symbol';
    const glyph=document.createElementNS(ns,'svg');glyph.setAttribute('class','icon');glyph.setAttribute('aria-hidden','true');
    const use=document.createElementNS(ns,'use');use.setAttribute('href','#i-'+row.icon);
    glyph.append(use);symbol.append(glyph);
    const text=document.createElement('span');text.className='rostertext';
    const name=document.createElement('strong');name.textContent=row.title;
    const info=document.createElement('small');info.textContent=row.info;
    text.append(name,info);button.append(symbol,text);
    // 行＝详情入口：与项目卡片、画布节点走**同一条**通路（交互律 06：向下钻，不横向跳）。
    button.onclick=()=>onOpen?.(row.id);
    rows.append(button);
   }
   section.append(rows);panel.append(section);
  }
  lastPainting=searchText();
 }
 /** 名册只在"正看着它"的时候干活。读完之后每敲一个字都只重画，**不再发请求**（纯前端过滤）。 */
 function refresh(){
  if(disposed||mode!=='roster')return;
  if(reads){if(lastPainting!==searchText())paint();return}
  if(!run){
   const pending=readAll();
   // 超 1 秒还没读到才写"正在读取"（本地读取通常更快，不闪一个假骨架，VI §7）。
   timer=setTimeout(()=>{if(!disposed&&mode==='roster'&&!reads)panel.replaceChildren(bar,noteLine('正在读取…'))},700);
   void pending.then(data=>{
    if(timer){clearTimeout(timer);timer=null}
    if(disposed)return;
    reads=data;
    if(mode==='roster')paint();
   });
  }
  panel.replaceChildren(bar,noteLine('正在读取…'));
 }
 search.oninput=()=>{if(mode==='roster')refresh()};
 return {
  tab:null,
  /** 门禁 4（control-audit）会把每个页签上的按钮都点一遍，所以要一个真的会渲染的入口。 */
  open(){mode='roster';panel.hidden=false;refresh()},
  /** 换页签：切到别段只是不可见，读到的数据与搜索词都留着。 */
  setMode(next){mode=next==='roster'?'roster':'portfolio';panel.hidden=mode!=='roster';if(mode==='roster')refresh()},
  /** 离开项目页时把名册收起来（它挂在文档上，不跟着 .view 一起隐藏），但**不改你的选择** ——
   *  回到项目页时你还停在离开前那一段。 */
  hide(){pageHidden=true;panel.hidden=true},
  /** 回到项目页：当初是被页面藏起来的，就照原样还回来。 */
  resume(){if(!pageHidden)return;pageHidden=false;if(mode==='roster'){panel.hidden=false;refresh()}},
  dispose(){disposed=true;if(timer){clearTimeout(timer);timer=null}search.oninput=null;search.onkeydown=null;panel.remove()},
 };
}

export async function mountProjectViews(document,send,onOpen,{onCreate}={}){
 const all=await readProjectModels(send);
 // 默认按优先级（重要×紧急）排序：用户要求"默认对项目紧急程度和重要程度自动排序"。
 const projects=sortByPriority(all);
 // 总览页「重点项目」：首页的卡片带（与项目页是两个页面，不算重复表达）。
 renderProjectStrip(document.querySelector('#projectstrip'),projects,{onCreate});
 const body=document.querySelector('#projectsbody');
 // 项目组合页：**一张项目卡只出现一次**（spec/54 §3.2 / PJ-01）。
 // 原来组合页是「卡片带 + 交付与阻塞分布」两处表达同一批项目，现在只留卡片带：
 // 真实交付进度已经在卡片里（0/0 不画环），交付构成只在「时间路线图 → 构成」那一个视图里看。
 const PORTFOLIO_HTML='<div class="projectstrip"></div>';
 const compositionHtml=list=>{
  const withDelivery=list.filter(p=>p.total);
  if(!withDelivery.length)return emptyState(document,{illustration:'complete',title:'还没有交付项',description:'给项目定下要交什么之后，这里按已完成 / 全部交付项展示进度。'}).outerHTML;
  return withDelivery.map(p=>`<button style="width:100%;text-align:left" data-project="${escapeHtml(p.id)}"><div class="meter"><span>${escapeHtml(p.name)}</span><i><em style="width:${Math.round(p.done/p.total*100)}%;background:${p.color}"></em></i><b>${p.done}/${p.total}</b></div></button>`).join('');
 };
 let currentVisible=projects;
 const roadmap=document.querySelector('#roadmap');
 const roadmapHtml=list=>list.length?projectRoadmap(list):emptyState(document,{illustration:'complete',title:'还没有计划区间',description:'项目设置计划开始与截止日期后，这里显示计划区间。'}).outerHTML;
 const paintPortfolio=list=>{
  if(!body.hidden)body.innerHTML=PORTFOLIO_HTML;
  const strip=body.querySelector('.projectstrip');
  if(strip)renderProjectStrip(strip,list,{onCreate});
  if(!list.length&&!body.querySelector('.v7-empty'))showEmpty(body,{illustration:'projects',title:'还没有项目',description:'创建第一个项目后，交付项、任务与资料都会汇总到这里。',action:onCreate?{label:'新建项目',run:onCreate}:undefined});
 };
 paintPortfolio(projects);
 roadmap.innerHTML=roadmapHtml(projects);
 const roadtabs=document.querySelector('#roadtabs');const switchRoad=event=>{const tab=event.target.closest('[data-road]');if(!tab)return;for(const b of roadtabs.querySelectorAll('button')){const active=b===tab;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}roadmap.innerHTML=tab.dataset.road==='plan'?roadmapHtml(currentVisible):compositionHtml(currentVisible);};roadtabs.addEventListener('click',switchRoad);
 const portfolio=PORTFOLIO_HTML;const tabs=document.querySelector('#projecttabs');
  // 第三段「名册」：用户 2026-10-15 拍板放在**项目页**（不在关联空间）。名册本体挂在 #projectsbody
  // 之后而不是里面 —— 里面那两段会被整块 innerHTML 重写，名册要保住自己读到的数据与搜索词。
  const roster=createProjectRoster(document,{onOpen,onCreate,projects:all,readLists:(kind,offset)=>send('list',{kind,limit:200,offset,includeArchived:false})});
  const rosterTab=document.createElement('button');
  rosterTab.type='button';rosterTab.dataset.pmode='roster';rosterTab.textContent='名册';rosterTab.setAttribute('aria-pressed','false');
  // 追加在「时间路线图」之后 —— 分段控件上的顺序就是用户看到的三段顺序。
  tabs.append(rosterTab);
  // 离开项目页时只把名册收起来，**不改你的选择**：回到项目页你还停在离开前那一段。
  const projectView=document.querySelector('#projects');
  // MutationObserver 必须取**这个文档的**：Node 也有一个全局的，但它不是 jsdom 文档的构造器，
  // 用它 new 出来的观察者收不到这个文档的变更（实测：回调一次都不触发，名册会留在别人的页面上）。
  const Observer=document.defaultView?.MutationObserver??null;
  const pageWatch=projectView&&Observer?new Observer(()=>{(projectView.classList.contains('active')?roster?.resume():roster?.hide())}):null;
  pageWatch?.observe(projectView,{attributes:true,attributeFilter:['class']});
  const switchMode=event=>{const tab=event.target.closest('[data-pmode]');if(!tab)return;for(const b of tabs.querySelectorAll('button')){const active=b===tab;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}const mode=tab.dataset.pmode==='roster'?'roster':tab.dataset.pmode==='plan'?'plan':'portfolio';
  // 选中的那一段记在分段控件自己身上：一次保存触发的重新挂载不该把你弹回第一段。
  // 注册它。以前这里漏了这一步：函数写好了，但没有监听者 —— 于是三段里只有默认那段是真的，
  // 另外两段点了只变样式。实测：点「名册」aria-pressed 变 true，而 #projectsbody 仍是项目卡片。
  tabs.addEventListener('click',switchMode);
  tabs.dataset.pmode=mode;
  if(mode==='roster'){body.hidden=true;roster?.open();return}roster?.setMode('portfolio');body.hidden=false;
  if(mode==='portfolio'){paintPortfolio(currentVisible)}
  else body.innerHTML='<div class="surface pad">'+roadmapHtml(currentVisible)+'<div class="chartfoot">每条横线表示计划区间，非实际工时；点击展开阶段与任务。</div></div>';
 };tabs.addEventListener('click',switchMode);
  // 重新挂载后按记住的那一段恢复（与「画布 ｜ 列表」原来那版同一个口径：选择不因重新挂载而丢）。
  if(tabs.dataset.pmode==='roster'){rosterTab.classList.add('active');rosterTab.setAttribute('aria-pressed','true');roster?.open()}
  // 筛选栏：注入到项目页签之后；变更时重渲染组合卡与路线图（不重新拉数据）。
 const filters=mountFilters(document,send);
 const renderWithFilters=state=>{
  const visible=applyProjectFilters(all,state);
  currentVisible=visible;
  // **必须先确认元素在**。切到「时间路线图」时 `body.innerHTML` 被整块重写，
  // `.projectstrip` 随之消失；此后任何一个 `project-filters` 事件（例如在收件箱同意一条改动
  // 引发重绘）都会让 querySelector 返回 null，`renderProjectStrip` 里 `root.innerHTML=` 当场抛
  // 「Cannot set properties of null」。实测栈：renderProjectStrip ← renderWithFilters ← project-filters 监听。
  const strip=body.querySelector('.projectstrip');
  if(strip)renderProjectStrip(strip,visible,{onCreate:visible.length?onCreate:undefined});
  if(!visible.length&&!strip)body.innerHTML=`<p class="notice" data-filtered-empty="1">当前筛选没有项目。筛选条件：${[
   state.stage&&'阶段 '+state.stage,state.partnerId&&'机构',state.ownerId&&'负责人',
   state.importance&&'重要度 '+(state.importance==='none'?'未设置':priorityLabels(state.importance)),
   state.urgency&&'紧急度 '+(state.urgency==='none'?'未设置':priorityLabels(state.urgency)),
   state.delivery&&'交付状态',].filter(Boolean).join(' · ')||'（无）'}。可以把筛选改回「全部」。</p>`;
  if(!roadmap)return;
  roadmap.innerHTML=visible.length?projectRoadmap(visible):emptyState(document,{illustration:'complete',title:'当前筛选没有计划区间',description:'把筛选改回「全部」，或给项目填写计划日期。'}).outerHTML;
 };
 if(filters)document.addEventListener('project-filters',event=>renderWithFilters(event.detail));
 const roots=[document.querySelector('#projectstrip'),body,roadmap];
 const click=event=>{const button=event.target.closest('[data-project]');if(button&&event.currentTarget.contains(button))onOpen(button.dataset.project);};
 for(const root of roots)root.addEventListener('click',click);
 return {projects,dispose(){if(filters){filters.bar?.toggle.remove();filters.box.remove()}tabs.removeEventListener('click',switchMode);roadtabs.removeEventListener('click',switchRoad);tabs.removeEventListener('click',switchMode);pageWatch?.disconnect();rosterTab.remove();roster?.dispose();for(const root of roots)root.removeEventListener('click',click)}};
}
