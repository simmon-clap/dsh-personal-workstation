import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {createIntake} from '../prototype/intake.mjs';

// 体检 A4：「＋录入」过去只有两个跳转按钮。现在要能粘贴 / 选择文件 / 拖放 / 输入链接 / 指定目标项目 / 指定目标任务，
// 而且**一切仍然只生成草稿**（进收件箱确认才写入），链接不抓正文，拖放不给服务端任何新的目录权限。
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(times=8)=>{for(let i=0;i<times;i+=1)await tick()};

function harness({grants=[{id:'g1',label:'会议（读写）',read:true,write:true}]}={}){
 const dom=shell(),document=dom.window.document,calls=[],notices=[];
 const drafts=[];
 const send=async(action,data={})=>{
  calls.push({action,data});
  if(action==='list')return {items:data.kind==='project'?[{id:'p1',kind:'project',data:{title:'示例科技'}}]:[{id:'t1',kind:'task',data:{title:'跟进试点'}},{id:'t2',kind:'task',data:{title:'整理材料'}}]};
  if(action==='file_grants')return {items:grants};
  if(action==='file_list')return {items:[{name:'a.md',type:'file'},{name:'sub',type:'directory'}],nextOffset:null};
  if(action==='file_read')return {content:'# 会议纪要\n一、试点范围',version:'v7'};
  if(action==='draft'){drafts.push(data);return {id:'b1'}}
  throw Error('unexpected '+action);
 };
 const opened=[];
 const intake=createIntake(document,send,{open:async()=>{}},{notify:(text,error)=>notices.push({text,error}),openSearch:()=>opened.push('search'),onBatch:id=>opened.push(id)});
 return {dom,document,send,calls,notices,drafts,intake,opened};
}

test('pasting text with a target project and tasks becomes one draft batch',async()=>{
 const h=harness();
 try{
  await h.intake.open();await settle();
  const {document}=h;
  assert.equal(document.querySelector('#detailtype').textContent,'录入');
  document.querySelector('#intaketitle').value='会议纪要 · 示例科技路演';
  document.querySelector('#intakecontent').value='一、试点范围：联合验证\n二、负责人：伙伴 A';
  document.querySelector('[data-intake="projectId"]').value='p1';
  const taskSelect=document.querySelector('[data-intake-task="taskIds"]');
  taskSelect.value='t1';taskSelect.onchange();
  taskSelect.value='t2';taskSelect.onchange();
  assert.equal(document.querySelector('[data-intake="taskIds"]').value,'t1,t2','多选任务必须真的累积');
  assert.equal(document.querySelectorAll('[data-intakechips] [data-taskchip]').length,2);
  document.querySelector('#intakedraft').click();await settle();
  assert.equal(h.drafts.length,1,'录入必须生成一个改动待确认的改动');
  const draft=h.drafts[0];
  assert.match(draft.title,/录入资料记录 · 会议纪要/);
  assert.equal(draft.changes.length,1);
  const change=draft.changes[0];
  assert.equal(change.op,'create');assert.equal(change.kind,'artifact');
  assert.equal(change.data.projectId,'p1');
  assert.deepEqual(change.data.taskIds,['t1','t2'],'材料要能同时挂多个任务（多对多）');
  assert.match(change.data.content,/一、试点范围/);
  assert.equal(change.sources.content,'用户粘贴的文本','来源必须如实写成用户粘贴，不能编');
  assert.equal(change.sources.projectId,'用户在录入对话框指定');
  assert.equal(change.sources.taskIds,'用户在录入对话框指定');
  assert.deepEqual(h.opened,['b1'],'生成待确认的改动后必须打开同一批的预览');
  assert.deepEqual(h.notices.filter(item=>item.error),[]);
 }finally{h.dom.window.close()}
});

test('a source link is registered without fetching the page (link fetching is not integrated)',async()=>{
 const h=harness();
 try{
  await h.intake.open();await settle();
  const {document}=h;
  document.querySelector('#intaketitle').value='外部资料';
  document.querySelector('#intakelink').value='https://example.com/report';
  document.querySelector('#intakedraft').click();await settle();
  const data=h.drafts[0].changes[0].data;
  assert.deepEqual(data.sourceRefs,['https://example.com/report'],'链接要登记成来源引用');
  assert.match(data.description,/正文未抓取/,'必须写明正文没有抓取，不能假装读到了内容');
  assert(!h.calls.some(call=>/fetch|link|url/.test(call.action)),'不得调用任何抓取接口');
 }finally{h.dom.window.close()}
});

test('dropping a file reads a browser-side snapshot and says it grants nothing new',async()=>{
 const h=harness();
 try{
  await h.intake.open();await settle();
  const {document}=h,zone=document.querySelector('#intakedrop');
  // 两处都要说清边界：拖放区自己写着"不会让工作台获得新的目录权限"，下面再说明服务端只读已授权目录。
  assert.match(zone.textContent,/不会让工作台获得新的目录权限/,'拖放区必须写明不会带来新的目录权限');
  assert.match(document.querySelector('[data-intakedropnote]').textContent,/只能读「空间与设置 → 目录授权」里已授权的目录/,
   '还要写明服务端只读已授权目录');
  const file=new h.dom.window.File(['# 拖入的纪要\n正文'],'dropped.md',{type:'text/markdown'});
  const event=new h.dom.window.Event('drop',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});
  zone.dispatchEvent(event);await settle();
  assert.match(document.querySelector('#intakecontent').value,/拖入的纪要/,'拖入的文本要进内容框');
  assert.equal(document.querySelector('#intaketitle').value,'dropped','没填名称时用文件名兜底');
  document.querySelector('#intakedraft').click();await settle();
  const change=h.drafts[0].changes[0];
  assert.equal(change.sources.content,'用户拖入的文件 dropped.md','来源要写明是用户拖入的文件');
  assert.equal(change.data.path,undefined,'拖放不产生服务端路径，不得编一个出来');
 }finally{h.dom.window.close()}
});

test('choosing a file from an authorized directory records its path, grant and version',async()=>{
 const h=harness();
 try{
  await h.intake.open();await settle();
  const {document}=h;
  document.querySelector('#intakepick').click();await settle();
  assert(h.calls.some(call=>call.action==='file_grants'),'选择文件必须先问授权目录');
  assert(h.calls.some(call=>call.action==='file_list'),'要能浏览目录');
  const fileButton=[...document.querySelectorAll('[data-intakefile]')].find(node=>node.textContent.includes('a.md'));
  assert(fileButton,'目录里的文件必须可点');
  fileButton.click();await settle();
  assert.match(document.querySelector('#intakecontent').value,/一、试点范围/);
  assert.equal(document.querySelector('#intaketitle').value,'a.md');
  document.querySelector('#intakedraft').click();await settle();
  const change=h.drafts[0].changes[0];
  assert.equal(change.data.path,'a.md');
  assert.equal(change.data.fileGrantId,'g1');
  assert.match(change.sources.content,/读取授权目录文件 a\.md（版本 v7）/);
 }finally{h.dom.window.close()}
});

test('a read-only directory and an empty intake are refused with an actionable message',async()=>{
 const h=harness({grants:[{id:'g1',label:'语音目录（只读）',read:true,write:false}]});
 try{
  await h.intake.open();await settle();
  const {document}=h;
  document.querySelector('#intakepick').click();await settle();
  assert.match(document.querySelector('#intakefilebody').textContent,/空间与设置 → 目录授权|授权目录/,'只读授权仍要能读；未授权的目录要说清去哪授权');
  document.querySelector('#intakecontent').value='';
  document.querySelector('#intakeclose').click();
  await h.intake.open();await settle();
  document.querySelector('#intakedraft').click();await settle();
  assert.match(h.notices.at(-1).text,/请先填写名称/,'空名称必须拒绝');
  document.querySelector('#intaketitle').value='只有名称';
  document.querySelector('#intakedraft').click();await settle();
  assert.match(h.notices.at(-1).text,/还没有可录入的内容/,'只有标题没有内容也必须说清楚');
 }finally{h.dom.window.close()}
});

test('研究议题 does not take task links',async()=>{
 const h=harness();
 try{
  await h.intake.open();await settle();
  const {document}=h;
  document.querySelector('#intaketitle').value='一个想法';
  document.querySelector('#intakecontent').value='先验证口径';
  document.querySelector('[data-intake="kind"]').value='topic';
  const taskSelect=document.querySelector('[data-intake-task="taskIds"]');
  taskSelect.value='t1';taskSelect.onchange();
  document.querySelector('#intakedraft').click();await settle();
  assert.match(h.notices.at(-1).text,/研究议题不挂任务/,'议题不支持任务关联，必须当场说清而不是静默丢弃');
  assert.equal(h.drafts.length,0);
 }finally{h.dom.window.close()}
});
