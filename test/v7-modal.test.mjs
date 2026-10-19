import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {sharedModal} from '../prototype/modal.mjs';
import {createProjectDetail} from '../prototype/project-detail.mjs';
import {createTaskDetail} from '../prototype/task-detail.mjs';
const setup=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));

test('one V7 modal traps focus, restores background and refuses dirty replacement or close',()=>{
 const dom=setup(),doc=dom.window.document,m=sharedModal(doc);try{
 assert.equal(m,sharedModal(doc));const opener=doc.querySelector('#create');opener.focus();doc.querySelector('main').inert=true;
 let allow=false;const token=m.begin();m.present(token,{title:'编辑',type:'TASK',html:'<input id="edit"><button id="last">保存</button>',beforeClose:()=>allow});
 assert(doc.querySelector('.nav').inert);assert(doc.querySelector('main').inert);assert.equal(m.begin(),null);assert.equal(m.close(),false);
 // 弹窗里第一个可聚焦元素现在是头部的「返回」（此前是右上角 ✕）：Tab 回绕应当落到它。
 const last=doc.querySelector('#last');last.focus();doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(doc.activeElement,doc.querySelector('#detailback'));
 doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(doc.activeElement,last);
 opener.focus();assert.equal(doc.activeElement,doc.querySelector('.close'));allow=true;m.close();assert.equal(doc.activeElement,opener);assert.equal(doc.querySelector('.nav').inert,undefined);assert.equal(doc.querySelector('main').inert,true);assert(!m.current(token));
 }finally{m.dispose();dom.window.close();}
});
test('task and project share request generation, so late project cannot overwrite task',async()=>{
 const dom=setup(),doc=dom.window.document;let finish;
 const send=async(action,{id})=>id==='p'?new Promise(r=>finish=r):{item:{id:'t',kind:'task',data:{title:'任务'}}};
 const p=createProjectDetail(doc,send,{openGraph(){},openIntake(){}}),t=createTaskDetail(doc,send,{openProject(){}});
 try{const pending=p.open('p');await t.open('t');finish({item:{id:'p',kind:'project',data:{title:'旧项目'}}});await pending;assert.equal(doc.querySelector('#detailtitle').textContent,'任务');p.dispose();assert(doc.querySelector('#veil').classList.contains('open'));doc.querySelector('.close').click();assert(!doc.querySelector('#veil').classList.contains('open'));}finally{p.dispose();t.dispose();sharedModal(doc).dispose();dom.window.close();}
});

test('clicking outside the dialog closes it, but a drag that ends outside does not',()=>{
 const dom=setup(),document=dom.window.document;
 const modal=sharedModal(document);
 try{
  const token=modal.begin();
  modal.present(token,{title:'测试弹窗',type:'TEST',html:'<p>内容</p>'});
  const veil=document.querySelector('#veil');
  assert(veil.classList.contains('open'));
  // 在弹窗内部按下、拖到遮罩上松开：不应关闭（否则选字/拖动会误关）
  const dialog=veil.querySelector('[role="dialog"]');
  dialog.dispatchEvent(new dom.window.PointerEvent('pointerdown',{bubbles:true}));
  veil.dispatchEvent(new dom.window.PointerEvent('pointerup',{bubbles:true}));
  assert(veil.classList.contains('open'),'从弹窗内拖出的点击不应关闭弹窗');
  // 按在遮罩上、也在遮罩上松开：应当关闭
  veil.dispatchEvent(new dom.window.PointerEvent('pointerdown',{bubbles:true}));
  veil.dispatchEvent(new dom.window.PointerEvent('pointerup',{bubbles:true}));
  assert(!veil.classList.contains('open'),'点击弹窗外部应当关闭');
 }finally{modal.dispose();dom.window.close()}
});

test('every dialog has a back control: it goes up one level when there is a parent, otherwise it closes',()=>{
 const dom=setup(),document=dom.window.document;
 const modal=sharedModal(document);
 try{
  const back=document.querySelector('#detailback');
  assert(back,'弹窗头部必须有返回按钮');
  assert.equal(back.getAttribute('aria-label'),'返回');
  // 有上一级：调用方给的 onBack 会被执行，弹窗关闭
  let parentOpened=0;
  const first=modal.begin();
  modal.present(first,{title:'任务详情',type:'任务',html:'<p>任务</p>',onBack:()=>{parentOpened+=1}});
  back.click();
  assert.equal(parentOpened,1,'有上一级时必须回到上一级');
  assert(!document.querySelector('#veil').classList.contains('open'),'返回后面板收起');
  // 没有上一级：返回等同于关闭
  const second=modal.begin();
  modal.present(second,{title:'设置',type:'空间与设置',html:'<p>设置</p>'});
  back.click();
  assert(!document.querySelector('#veil').classList.contains('open'),'没有上一级时返回应关闭');
 }finally{modal.dispose();dom.window.close()}
});
