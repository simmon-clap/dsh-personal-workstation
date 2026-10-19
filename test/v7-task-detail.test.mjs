import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {createTaskDetail,taskDetailHtml} from '../prototype/task-detail.mjs';

test('V7 task detail uses explicit step flags and separates execution from business status',()=>{
 const html=taskDetailHtml({id:'t',data:{title:'任务',status:'in_progress',steps:[{title:'<script>',done:false},{title:'完成',done:true}],inputScope:'<input>',expectedOutput:'报告'}},null);
 assert.match(html,/运行中/);assert.match(html,/1\/2/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;input&gt;/);assert.match(html,/尚无执行记录/);assert.doesNotMatch(html,/当前步骤|data-project|NaN/);
 assert.doesNotMatch(taskDetailHtml({id:'t',data:{title:'空任务'}},null),/NaN|Infinity/);
});
test('V7 task detail opens persisted project, restores focus and discards closed or late responses',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const doc=dom.window.document,p={id:'p',kind:'project',data:{title:'项目'}},t={id:'t',kind:'task',data:{title:'任务',projectId:'p'}},q={id:'q',kind:'task',data:{title:'另一任务'}};let finish,delay=false;const opened=[];
 const controller=createTaskDetail(doc,async(action,args)=>delay&&args.id==='t'?new Promise(r=>finish=r):{item:args.id==='p'?p:args.id==='t'?t:q},{openProject:id=>opened.push(id)});
 try{const opener=doc.querySelector('#create');opener.focus();await controller.open('t');doc.querySelector('#detailbody [data-project]').click();assert.deepEqual(opened,['p']);assert.equal(doc.activeElement,doc.querySelector('.close'));controller.close();assert.equal(doc.activeElement,opener);
 delay=true;let pending=controller.open('t');await controller.open('q');finish({item:t});await pending;assert.equal(doc.querySelector('#detailtitle').textContent,'另一任务');
 pending=controller.open('t');controller.close();finish({item:t});await pending;assert(!doc.querySelector('#veil').classList.contains('open'));
 await assert.rejects(createTaskDetail(doc,async()=>({item:{...t,archived:true}}),{openProject(){}}).open('t'),/已归档/);
 }finally{controller.dispose();dom.window.close();}
});
