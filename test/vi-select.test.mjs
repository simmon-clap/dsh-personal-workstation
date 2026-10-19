import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {selectHtml,wireSelects} from '../prototype/vi-select.mjs';

const mount=html=>{const dom=new JSDOM('<body><div id="root"></div></body>');const document=dom.window.document;document.querySelector('#root').innerHTML=html;return {dom,document}};

test('the VI select replaces native dropdowns and keeps the same value contract',()=>{
 const {document}=mount(selectHtml({name:'status',label:'业务状态',value:'todo',options:[['todo','待办'],['done','已完成']]}));
 // 仍输出 [data-field] 的 hidden input：现有表单取值逻辑不用改
 const input=document.querySelector('input[type="hidden"][data-field="status"]');
 assert(input,'必须保留 data-field 取值契约');
 assert.equal(input.value,'todo');
 assert.equal(document.querySelector('.viselect-button').tagName,'BUTTON');
 assert.equal(document.querySelector('.viselect-button').getAttribute('aria-haspopup'),'listbox');
 assert(!document.querySelector('select'),'不得再出现原生下拉');
});
test('opening, choosing and closing behave like a native select',()=>{
 const {document}=mount(selectHtml({name:'stage',value:'',options:[['','待规划'],['方案','方案']],placeholder:'待规划'}));
 const root=document.querySelector('#root');
 wireSelects(root,{document});
 const wrapper=document.querySelector('[data-viselect]'),list=document.querySelector('[data-viselect-list]'),input=document.querySelector('input[type="hidden"]');
 assert(list.hidden,'默认收起');
 document.querySelector('[data-viselect-button]').onclick();
 assert(!list.hidden,'点击展开');
 assert.equal(document.querySelector('[data-viselect-button]').getAttribute('aria-expanded'),'true');
 document.querySelector('[data-viselect-option="方案"]').onclick();
 assert.equal(input.value,'方案','选择后保存回 hidden input');
 assert.equal(document.querySelector('[data-viselect-text]').textContent,'方案','按钮显示所选文本');
 assert.equal(document.querySelector('[data-viselect-option="方案"]').getAttribute('aria-selected'),'true');
 assert(list.hidden,'选择后收起');
 // 再点开、用 Escape 收起，不能改值
 document.querySelector('[data-viselect-button]').onclick();
 list.onkeydown({key:'Escape',preventDefault(){}});
 assert(list.hidden,'Escape 收起');
 assert.equal(input.value,'方案','Escape 不改变取值');
 assert(wrapper,'wrapper 仍在');
});
test('every dialog uses the VI select instead of a native one',()=>{
 const files=readdirSync(new URL('../prototype/',import.meta.url)).filter(name=>name.endsWith('.mjs')&&!name.includes('audit'));
 const offenders=[];
 for(const name of files){
  const source=readFileSync(new URL('../prototype/'+name,import.meta.url),'utf8');
  if(/<select[ >]/.test(source)&&name!=='vi-select.mjs')offenders.push(name);
 }
 assert.deepEqual(offenders,[],'弹窗里不得再出现原生 <select>：'+offenders.join('、'));
});

test('previously hidden fields are now editable and survive a round trip',async()=>{
 const {createEditor}=await import('../prototype/editor.mjs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document,win=dom.window;
 const items={
  organization:[{id:'o1',kind:'organization',archived:false,data:{title:'伙伴 A'}}],
  person:[{id:'u1',kind:'person',archived:false,data:{title:'张工'}}],
  task:[{id:'t1',kind:'task',archived:false,data:{title:'试点方案整理'}}],
  project:[],
 };
 const batches=[];
 const send=async(action,data)=>action==='list'?{items:(items[data.kind]??[])}:{item:null};
 const editor=createEditor(document,send,{draft:async(title,changes)=>{batches.push({title,changes});return {id:'b1'}}},{notify:()=>{}});
 // 项目：合作机构 + 负责人（PRD v1.2 PJ-06 要求，此前数据里有、界面没有）
 await editor.open('project');
 let body=document.querySelector('#detailbody');
 const fieldNames=[...body.querySelectorAll('[data-viselect] input[type=hidden]')].map(input=>input.dataset.field);
 assert(fieldNames.includes('partnerId'),'项目表单必须有合作机构');
 assert(fieldNames.includes('ownerId'),'项目表单必须有负责人');
 body.querySelector('input[data-field=title]').value='联合验证';
 const pick=(field,value)=>{const wrapper=[...body.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input')?.dataset.field===field);wrapper.querySelector('[data-viselect-option="'+value+'"]').onclick()};
 pick('partnerId','o1');pick('ownerId','u1');
 body.querySelector('#objpreview').click();
 await new Promise(resolve=>setTimeout(resolve,60));
 const projectData=batches[0].changes[0].data;
 assert.equal(projectData.partnerId,'o1');
 assert.equal(projectData.ownerId,'u1');
 assert.equal(projectData.title,'联合验证');
 // 任务：负责人（单选）+ 依赖任务（多值，还原成数组）
 await editor.open('task');
 body=document.querySelector('#detailbody');
 body.querySelector('input[data-field=title]').value='试点方案整理';
 const owner=[...body.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input')?.dataset.field==='ownerId');
 owner.querySelector('[data-viselect-option="u1"]').onclick();
 const add=[...body.querySelectorAll('[data-viselect]')].find(node=>node.querySelector('input')?.dataset.field==='dependsOn-add');
 add.querySelector('[data-viselect-option="t1"]').onclick();
 add.querySelector('input[type=hidden]').dispatchEvent(new win.Event('change',{bubbles:true}));
 assert.equal(body.querySelectorAll('[data-refchips="dependsOn"] .refchip').length,1,'依赖应显示为可移除的标签');
 body.querySelector('#objpreview').click();
 await new Promise(resolve=>setTimeout(resolve,60));
 const taskData=batches[1].changes[0].data;
 assert.deepEqual(taskData.dependsOn,['t1'],'依赖必须还原成数组，而不是逗号字符串');
 assert.equal(taskData.ownerId,'u1');
});
test('reference names are resolved for display, and a missing record is stated instead of showing an id',async()=>{
 const {refLabels}=await import('../prototype/ref-labels.mjs');
 const send=async(action,data)=>action==='list'?{items:data.kind==='person'?[{id:'u1',kind:'person',data:{title:'张工'}}]:[]}:{item:null};
 const refs=refLabels(send);
 const line=await refs.line('person',['u1','u404'],'负责人');
 assert.match(line,/张工/,'必须显示真实名称');
 assert.match(line,/已删除或不可见/,'查不到的引用要如实说明，不能把 ID 当名字');
 assert.equal(await refs.line('person',[],'负责人'),'','没有引用时不生成这一行');
 refs.clear();
});
