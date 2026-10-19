import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {batchComposition,createInbox} from '../prototype/inbox.mjs';

// 体检 A4「收件箱承载范围」：一次会议的整套产物（录音、纪要、议题、任务）本来就属于同一批，
// 卡片要把这一批聚合成"这次归档产出了什么"，而不是让它们看起来互不相关。
const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

const batch={id:'b1',title:'会议纪要归档 · 示例科技',revision:1,status:'draft',updatedAt:'2026-10-12T10:00:00.000Z',source:{operator:'operator'},changes:[
 {op:'create',id:'p1',kind:'project',data:{title:'示例科技'}},
 {op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要 · 路演',path:'meetings/a.md',projectId:'p1'}},
 {op:'create',id:'a2',kind:'artifact',data:{title:'录音原件.m4a',path:'voice/a.m4a',projectId:'p1'}},
 {op:'create',id:'t1',kind:'topic',data:{title:'3D 存算适配议题',projectId:'p1'}},
 {op:'create',id:'k1',kind:'task',data:{title:'跟进试点',projectId:'p1'}},
 {op:'create',id:'k2',kind:'task',data:{title:'整理材料',projectId:'p1'}},
]};

test('a meeting batch is summarised by what it produced (录音 / 资料 / 议题 / 任务)',()=>{
 assert.deepEqual(batchComposition(batch).map(part=>part.label+' '+part.count),['项目 1','资料 1','录音 1','研究议题 1','任务 2']);
 const single=batchComposition({changes:[{op:'create',kind:'artifact',data:{title:'纪要',path:'a.md'}}]});
 assert.deepEqual(single,[{label:'资料',count:1,titles:['纪要']}]);
 assert.deepEqual(batchComposition({changes:[]}),[]);
});

test('the inbox card shows the composition line and keeps the real titles',async()=>{
 const dom=shell(),document=dom.window.document,root=document.createElement('div');document.body.append(root);
 const send=async(action)=>{if(action==='inbox')return {items:[batch]};if(action==='preview')return {...batch,diff:[],conflicts:[],validationErrors:[]};throw Error(action)};
 const inbox=createInbox(document,send,{open:async()=>{},draft:async()=>{}},{notify:()=>{},projects:[{id:'p1',title:'示例科技'}]});
 try{
  await inbox.render(root);await tick();await tick();
  const line=root.querySelector('[data-composition="1"]');
  assert(line,'收件箱卡片必须给出这一批的产出构成');
  assert.match(line.textContent,/资料 1 · 录音 1 · 研究议题 1 · 任务 2/,'按记录类型聚合，录音按扩展名认');
  assert.match(line.textContent,/项目 1/,'同批新建的项目也算这次归档的产出');
  assert.match(root.textContent,/会议纪要 · 路演/,'聚合不等于丢掉具体名称');
  assert.match(root.querySelector('[data-linktext="1"]').textContent,/归属：示例科技/,'构成行与归属行互不干扰');
 }finally{inbox.dispose();dom.window.close()}
});
