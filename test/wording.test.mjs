import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const run=args=>{
 try{return {code:0,out:execFileSync(process.execPath,['prototype/wording-audit.mjs',...args],{encoding:'utf8',cwd:new URL('..',import.meta.url)})}}
 catch(error){return {code:error.status??1,out:String(error.stdout??'')+String(error.stderr??'')}}
};

// 用户 2026-10-12：「什么叫差异化」「这里还有什么提交，我需要提交什么」——术语泄漏不是个别页面问题。
test('全站界面文案不得出现内部术语（收件箱/知识/画布/宿主提示都算）',()=>{
 const result=run([]);
 assert.equal(result.code,0,'界面文案里出现了用户看不懂的内部术语：\n'+result.out);
 assert.match(result.out,/PASS: 全站界面文案没有内部术语/);
});

test('文案门禁不是摆设：注入的假术语必须被报出来',()=>{
 const result=run(['--self-test']);
 assert.equal(result.code,0,'自检必须通过：\n'+result.out);
 assert.match(result.out,/自检通过/);
});

test('收件箱与批次弹窗的关键动作都用人话（同意 / 不同意 / 稍后再决定）',async()=>{
 const batch=await import('../prototype/batch.mjs');
 const source=(await import('node:fs')).readFileSync(new URL('../prototype/batch.mjs',import.meta.url),'utf8');
 for(const label of ['全部同意','同意所选','全部不同意','稍后再决定'])assert(source.includes(label),'弹窗必须提供：'+label);
 // 不许再把"提交/草稿/差异"端给用户（门禁也盯着，这里给一条更直白的回归断言）
 const literals=[...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(m=>m[1]??m[2]??m[3]??'');
 for(const term of ['提交','草稿','差异','回执','批次']){
  const hits=literals.filter(text=>text.includes(term));
  assert.deepEqual(hits,[],'弹窗里不该再出现「'+term+'」：'+hits.slice(0,3).join(' / '));
 }
 void batch;
});

test('收件箱弹窗必须为"带项目的改动"渲染出人话行（曾因作用域引用错误渲染成空白）',async()=>{
 const {readFileSync}=await import('node:fs');
 const {JSDOM}=await import('../dev-deps.mjs');
 const {WorkstationStore}=await import('../src/store.mjs');
 const {browserRoute}=await import('../src/browser-api.mjs');
 const {createBatchFlow}=await import('../prototype/batch.mjs');
 const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const dom=shell(),document=dom.window.document;
 const store=new WorkstationStore(':memory:');
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 const send=async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));return response.json()};
 try{
  const projects=await send('draft',{title:'建项目',changes:[{op:'create',id:'p1',kind:'project',data:{title:'示例科技'}}]});
  await send('commit',{id:projects.id,revision:projects.revision,key:'p'});
  const draft=await send('draft',{title:'给项目补材料',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',path:'a.md',projectId:'p1'}}]});
  const batch=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
  await batch.open(draft.id);
  const rows=[...document.querySelectorAll('.diffhuman')].map(node=>node.textContent);
  assert.equal(rows.length,1,'必须渲染出一行人话');
  assert.match(rows[0],/会议纪要/);
  assert.match(rows[0],/示例科技/,'项目要显示真名，不能显示 proj-xxx 或"已指定"');
  assert.doesNotMatch(rows[0],/p1\b/,'不得泄漏内部 id');
  const actions=[...document.querySelectorAll('#detailbody .modalactions button')].map(node=>node.textContent);
  assert(actions.some(text=>/同意/.test(text)),'必须有"同意"按钮：'+actions.join('/'));
  batch.dispose();
 }finally{store.close();dom.window.close()}
});
