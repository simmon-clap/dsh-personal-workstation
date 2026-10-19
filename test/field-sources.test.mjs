import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {toolDefinition} from '../src/dsh-adapter.mjs';
import {fieldSources} from '../prototype/batch.mjs';

// PRD v1.1 IN-AC-2：所有字段能查看来源。这里验证「逐字段来源」只在真有出处时才显示，
// 没标注就明确写「未标注来源」——模型不得凭空补出处。
function setup(){
 const store=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 return {store,ctx};
}
test('field sources are stored with the change and survive into the preview diff',()=>{
 const {store,ctx}=setup();
 try{
  const batch=store.draft(ctx,{title:'录入',changes:[
   {op:'create',id:'p',kind:'project',data:{title:'P',dueDate:'2026-11-01'},sources:{dueDate:'会议纪要第 3 段',title:'用户口述'}},
  ]});
  const preview=store.preview(ctx,batch.id);
  assert.deepEqual(preview.diff[0].sources,{dueDate:'会议纪要第 3 段',title:'用户口述'});
  store.commit(ctx,{batchId:batch.id,revision:1,key:'k'});
  assert.equal(store.get(ctx,'p').data.dueDate,'2026-11-01','来源标注不得影响写入的字段值');
 }finally{store.close()}
});
test('sources cannot annotate fields the change does not touch, nor invent provenance shapes',()=>{
 const {store,ctx}=setup();
 try{
  const cases=[
   [{op:'create',id:'p',kind:'project',data:{title:'P'},sources:{goal:'会议纪要'}},/只能标注本次变更包含的字段/],
   [{op:'create',id:'p',kind:'project',data:{title:'P'},sources:{title:''}},/1–200 字/],
   [{op:'create',id:'p',kind:'project',data:{title:'P'},sources:{title:'x'.repeat(201)}},/1–200 字/],
   [{op:'create',id:'p',kind:'project',data:{title:'P'},sources:['会议纪要']},/必须是对象/],
   [{op:'create',id:'p',kind:'project',data:{title:'P'},sources:Object.fromEntries(Array.from({length:51},(_,i)=>['title'+i,'x']))},/条目过多|只能标注本次变更包含的字段/],
  ];
  for(const [change,expected] of cases){
   assert.throws(()=>store.draft(ctx,{title:'x',changes:[change]}),expected,'非法来源必须被拒绝：'+JSON.stringify(change.sources));
  }
 }finally{store.close()}
});
test('the tool schema tells the model how to annotate sources without inventing them',()=>{
 const schema=toolDefinition({}).parameters.properties.changes.items.properties;
 assert(schema.sources,'工具必须接受逐字段来源');
 assert.equal(schema.sources.additionalProperties.type,'string');
 assert.match(schema.sources.description,/不要编造/,'必须明确要求不得编造出处');
});
test('the dialog shows annotated sources per changed field and says 未标注来源 otherwise',()=>{
 const withSources=fieldSources({before:null,after:{title:'P',dueDate:'2026-11-01'},sources:{dueDate:'会议纪要第 3 段'}});
 assert.match(withSources,/字段来源（1\/2 已标注）/,'必须给出标注覆盖率');
 assert.match(withSources,/截止日期：会议纪要第 3 段/,'字段名走中文标签（体检 A1：不再泄漏英文键）');
 assert.match(withSources,/标题：未标注来源/,'没标注的字段必须明确写未标注');
 assert.doesNotMatch(withSources,/(title|dueDate|path|fileGrantId|fileVersion|content)：/,'来源块的字段名不得回退成英文键');
 const none=fieldSources({before:null,after:{title:'P'},sources:null});
 assert.match(none,/字段来源（0\/1 已标注）/);
 assert.match(none,/标题：未标注来源/);
 assert.equal(fieldSources({before:{data:{title:'P'}},after:{title:'P'},sources:null}),'','没有字段变化时不应出现来源块');
});
test('per-field sources are visible in the real batch dialog',async()=>{
 const {createBatchFlow}=await import('../prototype/batch.mjs');
 const dom=new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
 const document=dom.window.document;
 const batch={id:'b',title:'会议整理',revision:1,status:'draft',changes:[],diff:[{op:'create',id:'p',before:null,after:{title:'P',dueDate:'2026-11-01'},sources:{dueDate:'会议纪要第 3 段'}}]};
 const send=async action=>{if(action==='preview')return batch;if(action==='batch_origin')return {available:false,reason:'人工录入',messages:[]};throw Error(action)};
 const flow=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  await flow.open('b');await new Promise(resolve=>setImmediate(resolve));
  const block=document.querySelector('#detailbody [data-sources]');
  assert(block,'待确认的改动对话框必须逐字段显示来源');
  assert.match(block.textContent,/截止日期：会议纪要第 3 段/);
  assert.match(block.textContent,/标题：未标注来源/);
  assert.doesNotMatch(block.textContent,/(title|dueDate|path|fileGrantId|fileVersion|content)：/,'来源块的字段名不得回退成英文键');
 }finally{flow.dispose();dom.window.close()}
});
