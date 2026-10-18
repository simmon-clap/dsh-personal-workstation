import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {createEditor} from '../prototype/editor.mjs';

// 体检 A3：编辑项目的表单是一路平铺的 52+ 控件——「说明」「目标」只有 154–183px 宽像坏掉的控件、
// 计划开始/截止/项目文件夹挤一行、交付项一行 6 个控件（含手填"负责人 ID（可留空）"与手写状态）。
// 这里锁住改造后的结构：四个分节、全宽字段、日期控件、交付项两行式、负责人/状态用选择器、标签不带开发式提示。
// 几何度量（控件总数/单行控件数/最窄输入框宽度）由 prototype/form-metrics.mjs 在真实浏览器里对照。

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(times=6)=>{for(let i=0;i<times;i+=1)await tick()};

function harness(){
 const dom=shell(),document=dom.window.document,notices=[];
 const project={id:'p1',kind:'project',revision:1,archived:false,data:{
  title:'联合验证',description:'说明文字',goal:'验证联合方案可行性',stage:'验证',partnerId:'o-1',ownerId:'pe-1',
  startDate:'2026-10-05',dueDate:'2026-11-15',folder:'项目/联合验证',
  deliverables:[{id:'d1',title:'交付项一',done:false,dueDate:'2026-10-20',ownerId:'pe-1',status:'doing'}]}};
 const send=async(action,data={})=>{
  if(action==='list'){
   if(data.kind==='person')return {items:[{id:'pe-1',data:{title:'伙伴 A'}},{id:'pe-2',data:{title:'伙伴 B'}}]};
   if(data.kind==='organization')return {items:[{id:'o-1',data:{title:'某机构'}}]};
   if(data.kind==='project')return {items:[project]};
   return {items:[]};
  }
  if(action==='get')return {item:project};
  if(action==='node_search')return {items:[]};
  if(action==='directory_list'){
   const path=String(data?.path??'').replace(/^\/+|\/+$/g,'');
   if(path==='')return {path:'',parent:'',items:[{name:'项目',path:'项目'}]};
   if(path==='项目')return {path:'项目',parent:'',items:[]};
   const error=Error('目录不存在：'+path);error.code='NOT_FOUND';throw error;
  }
  if(action==='directory_create')return {name:data?.name,path:(data?.path?data.path+'/':'')+(data?.name??'')};
  throw Error('unexpected '+action);
 };
 const applied=[];
 const batch={draft:async()=>({id:'b1'}),open:async()=>{},apply:async(title,changes)=>{applied.push({title,changes});return {id:'r1',key:'k1'}}};
 const editor=createEditor(document,send,batch,{notify:(text,error)=>notices.push({text,error})});
 return {dom,document,editor,notices,project,applied};
}

test('the project editor is split into the four sections instead of one flat list',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle();
  const body=h.document.querySelector('#detailbody');
  const sections=[...body.querySelectorAll('[data-formsection]')];
  assert.equal(sections.length,5,'必须分成 5 节（新增「优先级」：用户要求可筛选并按重要×紧急排序）');
  assert.deepEqual(sections.map(node=>node.querySelector('h3').textContent),['基本信息','归属与负责人','优先级','计划','交付项']);
  // 名称与说明在第一节，且都挂在块级字段容器里（全宽由 CSS 保证，结构上必须是 .formfield）
  const basic=sections[0];
  assert(basic.querySelector('[data-field="title"]').closest('.formfield'),'名称必须是块级字段（原来行内 label 只有 154px）');
  assert(basic.querySelector('[data-field="description"]').closest('.formfield'),'说明必须全宽：体检报告里它只有 183px');
  // 归属与负责人：合作机构 / 负责人 / 所属项目都在这节
  const owner=sections[1];
  assert(owner.querySelector('[data-field="partnerId"]'),'合作机构应在「归属与负责人」');
  assert(owner.querySelector('[data-field="ownerId"]'),'负责人应在「归属与负责人」');
  // 优先级：重要程度 / 紧急程度（用户要求可筛选、并按重要×紧急默认排序）
  const priority=sections[2];
  for(const name of ['importance','urgency'])assert(priority.querySelector('[data-field="'+name+'"]'),name+' 应在「优先级」节');
  // 计划：阶段 / 开始 / 截止 / 文件夹
  const plan=sections[3];
  for(const name of ['stage','startDate','dueDate','folder'])assert(plan.querySelector('[data-field="'+name+'"]'),name+' 应在「计划」节');
 }finally{h.editor.dispose();h.dom.window.close()}
});

test('date fields use date controls and labels carry no developer hints',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle();
  const body=h.document.querySelector('#detailbody');
  for(const name of ['startDate','dueDate']){
   const input=body.querySelector('[data-field="'+name+'"]');
   assert.equal(input.getAttribute('type'),'date',name+' 必须用统一的日期控件');
   assert.equal(input.value,name==='startDate'?'2026-10-05':'2026-11-15','已有日期必须回填');
  }
  const text=body.textContent;
  for(const hint of ['（YYYY-MM-DD）','（工作区内相对路径','负责人 ID（可留空）','状态：待办/进行中/已完成/受阻'])assert(!text.includes(hint),'标签里不允许再出现开发式提示：'+hint);
  assert.match(body.querySelector('[data-field="folder"]').placeholder,/项目\/联合验证/,'路径提示应降级成占位符');
 }finally{h.editor.dispose();h.dom.window.close()}
});

test('a deliverable is a two-line row with a date, an owner picker and a status picker',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle();
  const body=h.document.querySelector('#detailbody'),row=body.querySelector('#objchecklist .itemrow');
  assert(row,'交付项必须是一个条目块');
  const lines=[...row.querySelectorAll('.itemline')];
  // 第 3 批给交付项加了「阶段」选择器（第三行）；A3 的量化线是**每行 ≤3 个控件**，不是固定两行。
  assert(lines.length>=2,'交付项必须是分行的条目块');
  for(const line of lines)assert(line.children.length<=3,'每一行最多 3 个控件（A3 量化线）：'+line.innerHTML.slice(0,80));
  // 第一行：勾选 + 名称 + 删除（≤3 个控件）
  assert(lines[0].querySelector('[data-role="done"]'));
  assert(lines[0].querySelector('[data-role="itemtitle"]'));
  assert(lines[0].querySelector('[data-role="itemremove"]'));
  assert(lines[0].children.length<=3,'第一行最多 3 个控件');
  // 第二行：日期控件 + 负责人选择器 + 状态选择器（≤3 个控件，且不再手填）
  const due=lines[1].querySelector('[data-role="itemdue"]');
  assert.equal(due.getAttribute('type'),'date','交付项日期必须用日期控件');
  assert.equal(due.value,'2026-10-20','已有日期必须回填');
  const ownerLine=lines[1].querySelector('[data-role="itemowner"]');
  const statusLine=lines[1].querySelector('[data-role="itemstatus"]');
  assert(ownerLine.closest('[data-viselect]'),'负责人必须是选择器，不再是手填 ID');
  assert(statusLine.closest('[data-viselect]'),'状态必须是选择器，不再是手写文本');
  assert.equal(ownerLine.value,'pe-1','已有负责人必须回填');
  assert.equal(statusLine.value,'doing','已有状态必须回填');
  assert(lines[1].children.length<=3,'第二行最多 3 个控件');
  // 选择器的候选项来自真实 person 记录
  const options=[...ownerLine.closest('[data-viselect]').querySelectorAll('[data-viselect-option]')].map(node=>node.textContent);
  assert(options.includes('伙伴 A')&&options.includes('伙伴 B'),'负责人候选项必须来自工作台里的 person 记录：'+options.join('、'));
  assert(options.includes('负责人未指定'),'允许留空');
  const statusOptions=[...statusLine.closest('[data-viselect]').querySelectorAll('[data-viselect-option]')].map(node=>node.textContent);
  for(const label of ['待办','进行中','已完成','受阻'])assert(statusOptions.includes(label),'状态选项缺 '+label);
  assert.equal(lines[1].querySelectorAll('input:not([type="hidden"]),textarea,select').length,1,'第二行只有一个自由文本控件（日期），负责人与状态都必须走选择器');
 }finally{h.editor.dispose();h.dom.window.close()}
});

test('adding a checklist entry produces the same two-line row, wired for interaction',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle();
  const body=h.document.querySelector('#detailbody');
  body.querySelector('#objadditem').click();await settle();
  const rows=[...body.querySelectorAll('#objchecklist .itemrow')];
  assert.equal(rows.length,2,'添加条目必须真的多一行');
  const added=rows[1];
  assert(added.querySelectorAll('.itemline').length>=2,'新条目同样分行');
  assert(added.querySelector('[data-role="itemowner"]').closest('[data-viselect][data-viselect-wired="1"]'),'新行的选择器必须接线（否则点不开）');
 }finally{h.editor.dispose();h.dom.window.close()}
});

test('the folder field opens the shared directory browser and offers a way out of an invalid stored value',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle(12);
  const body=h.document.querySelector('#detailbody'),input=body.querySelector('[data-field="folder"]');
  assert.equal(input.value,'项目/联合验证','已有文件夹必须回填（不静默清空）');
  body.querySelector('[data-folderpick]').click();await settle(30);
  const panel=body.querySelector('[data-folderpanel]');
  assert(panel&&!panel.hidden,'选择文件夹必须打开面板');
  assert.match(panel.textContent,/原来填的「项目\/联合验证」不在工作区里/,'非法存量值必须有一句人话');
  assert.match(panel.textContent,/工作区/,'面板必须显示当前位置（面包屑）');
  const enter=panel.querySelector('[data-folder-enter="项目"]');
  assert(enter,'必须能从根目录进入真实文件夹（旧实现直接留空白）');
  enter.click();await settle(30);
  assert(panel.querySelector('[data-folder-select]'),'空目录也要能选中当前文件夹（旧实现的隐藏死路）');
  panel.querySelector('[data-folder-select]').click();await settle(12);
  assert.equal(input.value,'项目','选中后写入工作区内相对路径');
  assert(panel.hidden,'选中后收起面板');
 }finally{h.editor.dispose();h.dom.window.close()}
});

test('saving a project with a missing folder does not write and offers a candidate',async()=>{
 const h=harness();
 try{
  await h.editor.open('project',h.project);await settle(12);
  const body=h.document.querySelector('#detailbody');
  body.querySelector('#objpreview').click();await settle(40);
  assert.equal(h.applied.length,0,'文件夹不存在时不得写库');
  const fix=body.querySelector('[data-folderfix]');
  assert(fix&&!fix.hidden,'保存失败必须就地给出下一步');
  assert.match(fix.textContent,/没保存/);
  const candidate=fix.querySelector('[data-folder-candidate="项目"]');
  assert(candidate,'必须给出真实候选（不 hardcode、来自目录清单）');
  candidate.click();await settle(12);
  assert.equal(body.querySelector('[data-field="folder"]').value,'项目');
  body.querySelector('#objpreview').click();await settle(40);
  assert.equal(h.applied.length,1,'改成有效文件夹后再保存才写库');
  assert.equal(h.applied[0].changes[0].data.folder,'项目');
 }finally{h.editor.dispose();h.dom.window.close()}
});
