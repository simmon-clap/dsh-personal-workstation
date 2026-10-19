import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {inlineField} from '../prototype/inline-edit.mjs';
import {priorityOptions} from '../prototype/editor.mjs';
import {createProjectDetail} from '../prototype/project-detail.mjs';

// 就地编辑（03 §「十二条之外 · 就地编辑」）：
//   ① 值是可点的文字，点一下就地改，改完直接生效（契约②：自己的操作不弹确认）；
//   ② 失败要还原成原值并如实说原因，不能假装成功；
//   ③ 合作机构 / 负责人的下拉里必须有「＋ 新建」——否则"库里有什么就只能选什么"，
//      唯一的组织会被错挂到不相干的项目上（用户 2026-10-15 点名）。
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const settle=async(times=8)=>{for(let i=0;i<times;i+=1)await new Promise(resolve=>setImmediate(resolve))};

test('inline edit writes the new value in place, and a failed save reverts to the old one',async()=>{
 const dom=shell(),document=dom.window.document;
 const saved=[];
 const row=inlineField(document,{label:'目标',value:'',type:'textarea',onCommit:async next=>{saved.push(next)},notify:()=>{}});
 document.body.append(row);
 const value=()=>row.querySelector('.inlinevalue');
 assert.equal(value().textContent,'未设置','没填就如实写「未设置」');
 assert.equal(value().dataset.empty,'1','空值只靠文字说明，不靠颜色（VI §2）');
 value().click();
 const area=row.querySelector('textarea');
 assert.ok(area,'目标是一整句话，用多行输入');
 area.value='把试点跑到别人能复制';
 area.dispatchEvent(new dom.window.Event('change'));
 await settle();
 assert.deepEqual(saved,['把试点跑到别人能复制'],'改完立刻提交，不等"保存"按钮');
 assert.equal(value().textContent,'把试点跑到别人能复制','值行直接显示新值');
 assert.equal(value().dataset.empty,'','有值就不再是空态');

 // 失败必须还原 + 说明原因，不假装成功
 const errors=[];
 const failing=inlineField(document,{label:'名称',value:'旧名字',onCommit:async()=>{throw Error('名称不能为空')},notify:(text,error)=>errors.push([text,error])});
 document.body.append(failing);
 failing.querySelector('.inlinevalue').click();
 const input=failing.querySelector('input');
 input.value='新名字';
 input.dispatchEvent(new dom.window.Event('change'));
 await settle();
 assert.equal(failing.querySelector('.inlinevalue').textContent,'旧名字','保存失败要还原成原值');
 assert.deepEqual(errors,[['名称不能为空',true]],'失败要如实说原因（不弹确认、不假装成功）');
 dom.window.close();
});

test('inline select keeps the committed value when reopened, and offers only registered levels',async()=>{
 const dom=shell(),document=dom.window.document;
 const saved=[];
 const row=inlineField(document,{label:'重要程度',value:'',display:'未设置',options:priorityOptions,onCommit:async next=>{saved.push(next)},notify:()=>{}});
 document.body.append(row);
 row.querySelector('.inlinevalue').click();
 let hidden=row.querySelector('input[type="hidden"]');
 hidden.value='high';
 hidden.dispatchEvent(new dom.window.Event('change'));
 await settle();
 assert.deepEqual(saved,['high']);
 assert.equal(row.querySelector('.inlinevalue').textContent,'高','下拉里的取值直接用人话显示');
 // 再点开：显示的必须是刚改成的值（否则第二次修改会以旧值为基准）
 row.querySelector('.inlinevalue').click();
 hidden=row.querySelector('input[type="hidden"]');
 assert.equal(hidden.value,'high','重新打开时带着当前值，不是打开弹窗那一刻的旧值');
 dom.window.close();
});

test('project detail exposes 名称/目标/重要程度/紧急程度 in place, using the editor\'s own levels',async()=>{
 const dom=shell(),document=dom.window.document;
 const patches=[];
 const item={id:'p1',kind:'project',revision:3,archived:false,data:{title:'联合验证',goal:'验证联合方案可行性',importance:'high',stage:'方案',partnerId:'o1'}};
 const send=async(action,payload)=>action==='get'?{item}:{items:payload?.kind==='organization'?[{id:'o1',kind:'organization',data:{title:'伙伴 A'}}]:[]};
 const detail=createProjectDetail(document,send,{notify:()=>{},onInlineChange:async(target,patch)=>patches.push([target.id,patch])});
 try{
  await detail.open('p1');await settle();
  const body=document.querySelector('#detailbody');
  const labels=[...body.querySelectorAll('[data-inline-field]')].map(node=>node.dataset.inlineField);
  for(const label of ['名称','目标','重要程度','紧急程度','合作机构','负责人','开始','截止'])assert.ok(labels.includes(label),'项目详情必须能就地改「'+label+'」：'+labels.join('、'));
  const value=label=>body.querySelector('[data-inline-field="'+label+'"] .inlinevalue').textContent;
  assert.equal(value('名称'),'联合验证');
  assert.equal(value('目标'),'验证联合方案可行性');
  assert.equal(value('重要程度'),'高','重要程度与「编辑项目」同一套取值');
  assert.equal(value('紧急程度'),'未设置','没填就如实写「未设置」');
  assert.ok(body.querySelector('[data-inline-field="目标"] textarea, [data-inline-field="目标"][data-wide="1"]'),'目标这一行按长文本处理');
  // 改重要程度：直接生效，patch 里是编辑弹窗那一套取值（urgent 这类自造值进不来）
  const level=body.querySelector('[data-inline-field="重要程度"]');
  level.querySelector('.inlinevalue').click();
  const hidden=level.querySelector('input[type="hidden"]');
  hidden.value='low';
  hidden.dispatchEvent(new dom.window.Event('change'));
  await settle();
  assert.deepEqual(patches,[['p1',{importance:'low'}]]);
  assert.equal(level.querySelector('.inlinevalue').textContent,'低');
  // 改名称：标题行要跟着改，否则看着像没保存成功
  const title=body.querySelector('[data-inline-field="名称"]');
  title.querySelector('.inlinevalue').click();
  const input=title.querySelector('input');
  input.value='联合验证（二期）';
  input.dispatchEvent(new dom.window.Event('change'));
  await settle();
  assert.deepEqual(patches.at(-1),['p1',{title:'联合验证（二期）'}]);
  assert.equal(document.querySelector('#detailtitle').textContent,'联合验证（二期）');
 }finally{detail.dispose();dom.window.close()}
});

test('the 合作机构 dropdown can create a new organization, which is written to the workspace and auto-selected',async()=>{
 const dom=shell(),document=dom.window.document;
 const applied=[],patches=[];
 const batch={apply:async(title,changes,options)=>{applied.push({title,changes,options});return {key:'k-'+applied.length}},draft:async()=>({id:'b1'}),open:async()=>{}};
 const item={id:'p1',kind:'project',revision:3,archived:false,data:{title:'联合验证',stage:'方案'}};
 const send=async(action,payload)=>action==='get'?{item}:{items:payload?.kind==='organization'?[{id:'o1',kind:'organization',data:{title:'TK'}}]:[]};
 // 写入路径由调用方注入（v7-controller 传给项目详情的那一个 batch）；就地编辑与编辑弹窗共用它。
 const detail=createProjectDetail(document,send,{notify:()=>{},batch,onInlineChange:async(target,patch)=>patches.push([target.id,patch])});
 try{
  await detail.open('p1');await settle();
  const field=document.querySelector('#detailbody [data-inline-field="合作机构"]');
  field.querySelector('.inlinevalue').click();
  const options=[...field.querySelectorAll('[data-viselect-option]')].map(node=>node.textContent);
  assert.ok(options.includes('新建组织'),'下拉里必须有「新建组织」：'+options.join('、'));
  assert.ok(options.includes('TK'),'库里已有的组织仍然可选');
  // 选「新建组织」→ 展开一行输入（与编辑弹窗同一套控件，不弹第二层弹窗）
  assert.ok(field.querySelector('[data-viselect-option="__create__"] svg.icon use[href="#i-plus"]'),'加号用登记在册的线性图标（V9：不拿符号当图标）');
  field.querySelectorAll('[data-viselect-option]').forEach(node=>{if(node.textContent==='新建组织')node.click()});
  await settle(2);
  const line=field.querySelector('.refcreaterow');
  assert.ok(line,'下拉里选「新建」要展开一行输入');
  assert.equal(line.querySelector('button.primary').textContent,'建好并选中','与编辑弹窗用同一个按钮说法');
  line.querySelector('input').value='示例客户科技';
  line.querySelector('button.primary').click();
  await settle();
  assert.equal(applied.length,1,'新建必须真的写进工作台（走同一条写入路径）');
  assert.equal(applied[0].changes[0].op,'create');
  assert.equal(applied[0].changes[0].kind,'organization');
  assert.deepEqual(applied[0].changes[0].data,{title:'示例客户科技'});
  const id=applied[0].changes[0].id;
  assert.deepEqual(patches,[['p1',{partnerId:id}]],'建完自动选中：这个项目真的挂到了新组织上');
  assert.equal(field.querySelector('.inlinevalue').textContent,'示例客户科技','值行显示新组织名');
  // 再点开：新组织已经在候选里（不用重开弹窗就能再选到）
  field.querySelector('.inlinevalue').click();
  assert.ok([...field.querySelectorAll('[data-viselect-option]')].some(node=>node.textContent==='示例客户科技'),'新建的记录进入候选');
 }finally{detail.dispose();dom.window.close()}
});

test('inline edit commits against the freshest revision, so a second change on the same panel still lands',async()=>{
 const dom=shell(),document=dom.window.document;
 // 面板打开后这条记录已经被改过（revision 1 → 2）：提交时必须用最新版本，
 // 否则服务端判"刚被改过"整条拒绝，而界面还显示已改（实测踩过）。
 const revisions=[1,2,3];
 let calls=0;
 const send=async action=>{
  if(action!=='get')return {items:[]};
  const revision=revisions[Math.min(calls,revisions.length-1)];
  calls+=1;
  return {item:{id:'p1',kind:'project',revision,archived:false,data:{title:'联合验证',stage:'方案'}}};
 };
 const commits=[];
 const detail=createProjectDetail(document,send,{notify:()=>{},onInlineChange:async(target,patch)=>commits.push([target.revision,patch])});
 try{
  await detail.open('p1');await settle();
  const body=document.querySelector('#detailbody');
  for(const [label,next] of [['重要程度','high'],['紧急程度','low']]){
   const field=body.querySelector('[data-inline-field="'+label+'"]');
   field.querySelector('.inlinevalue').click();
   const hidden=field.querySelector('input[type="hidden"]');
   hidden.value=next;
   hidden.dispatchEvent(new dom.window.Event('change'));
   await settle();
  }
  assert.deepEqual(commits,[[2,{importance:'high'}],[3,{urgency:'low'}]],'每次提交都带最新版本号（第二次不是拿着旧版本硬写）');
 }finally{detail.dispose();dom.window.close()}
});

test('without any write path the dropdown offers no create entry — no button that does nothing',async()=>{
 const dom=shell(),document=dom.window.document;
 // 既没有注入 batch、也没有编辑弹窗登记写入路径：如实不显示「新建」，
 // 而不是给一个点了没反应的按钮（《开发规划与约束》约束三：未接入不伪造）。
 const item={id:'p1',kind:'project',revision:1,archived:false,data:{title:'联合验证',stage:'方案'}};
 const send=async(action,payload)=>action==='get'?{item}:{items:payload?.kind==='organization'?[{id:'o1',kind:'organization',data:{title:'TK'}}]:[]};
 const detail=createProjectDetail(document,send,{notify:()=>{},onInlineChange:async()=>{}});
 try{
  await detail.open('p1');await settle();
  const field=document.querySelector('#detailbody [data-inline-field="合作机构"]');
  field.querySelector('.inlinevalue').click();
  const options=[...field.querySelectorAll('[data-viselect-option]')].map(node=>node.textContent);
  assert.ok(options.includes('TK'),'库里已有的组织照常可选：'+options.join('、'));
  assert.ok(!options.some(text=>text.startsWith('新建')),'没有写入路径就不给「新建」入口：'+options.join('、'));
 }finally{detail.dispose();dom.window.close()}
});
