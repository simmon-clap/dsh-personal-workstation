import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {buildShell} from '../prototype/build-shell.mjs';
import {mountKnowledge,linkLabels} from '../prototype/knowledge-view.mjs';

// PRD v1.0 KN-01 与整体规划：简报必须能溯源（来源、发布时间、抓取时间、失效链接），
// 自动抓取/去重/摘要未接入时不产生任何「自动生成」的简报。
const shell=()=>new JSDOM(buildShell(readFileSync(new URL('../../工作台-视觉原型-v7.html',import.meta.url),'utf8')));
function store(){
 const instance=new WorkstationStore(':memory:'),ctx={workspace:'w',actor:'t',canWrite:true};
 const draft=data=>{const batch=instance.draft(ctx,{title:'简报',changes:[{op:'create',id:'b'+Math.random().toString(36).slice(2),kind:'brief',data:{title:'简报',...data}}]});return {batch,commit:()=>instance.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()})}};
 return {instance,ctx,draft};
}
test('a brief must carry a summary, a source and a registration time',()=>{
 const {instance,ctx,draft}=store();
 try{
  for(const [data,expected] of [[{source:'官方博客',fetchedAt:'2026-10-20'},/摘要内容/],[{content:'摘要',fetchedAt:'2026-10-20'},/来源名称/],[{content:'摘要',source:'官方博客'},/登记时间/],[{content:'摘要',source:'官方博客',fetchedAt:'昨天'},/登记时间/]]){
   const {batch}=draft(data);
   assert.throws(()=>instance.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()}),expected,'缺项必须被拒绝：'+JSON.stringify(data));
  }
 }finally{instance.close()}
});
test('brief provenance fields are format-checked instead of trusted',()=>{
 const {instance,ctx,draft}=store();
 try{
  const base={content:'摘要',source:'官方博客',fetchedAt:'2026-10-20'};
  for(const [extra,expected] of [[{publishedAt:'待确认'},/发布时间/],[{sourceUrl:'javascript:alert(1)'},/http\(s\)|来源链接/],[{linkStatus:'broken'},/链接状态/],[{uncertainty:'x'.repeat(301)},/不确定性/]]){
   const {batch}=draft({...base,...extra});
   assert.throws(()=>instance.commit(ctx,{batchId:batch.id,revision:1,key:'k'+Math.random()}),expected,'非法字段必须被拒绝：'+JSON.stringify(extra));
  }
  const good=draft({...base,publishedAt:'2026-10-18',sourceUrl:'https://example.com/post',linkStatus:'expired',uncertainty:'仅单一来源，尚未交叉验证'});
  good.commit();
  const item=instance.list(ctx,{kind:'brief'})[0];
  assert.equal(item.data.linkStatus,'expired');assert.equal(item.data.source,'官方博客');
 }finally{instance.close()}
});
test('the brief view shows real provenance, marks expired links and never invents missing fields',()=>{
 const {instance,ctx,draft}=store();
 const dom=shell(),document=dom.window.document;
 try{
  draft({content:'甲摘要',source:'官方博客',fetchedAt:'2026-10-20T03:00:00Z',publishedAt:'2026-10-18',sourceUrl:'https://example.com/a',linkStatus:'ok',title:'来源齐全'}).commit();
  draft({content:'乙摘要',source:'转载渠道',fetchedAt:'2026-10-21',linkStatus:'expired',title:'链接失效',uncertainty:'原始发布方不明'}).commit();
  draft({content:'丙摘要',source:'内部转述',fetchedAt:'2026-10-22',title:'字段缺失'}).commit();
  const items=instance.list(ctx,{kind:'brief',includeArchived:false});
  assert.equal(items.length,3);
  const view=mountKnowledge(document,items,'brief',{});
  try{
   const cards=[...document.querySelectorAll('#knowbody .resource')].map(node=>node.textContent);
   assert.equal(cards.length,3);
   const complete=cards.find(text=>text.includes('来源齐全'));
   assert.match(complete,/来源：官方博客/);assert.match(complete,/发布：2026-10-18/);assert.match(complete,/登记：2026-10-20T03:00:00Z/);assert.match(complete,/链接可用/);
   const expired=cards.find(text=>text.includes('链接失效'));
   assert.match(expired,/链接已失效/);assert.match(expired,/不确定性：原始发布方不明/);
   const missing=cards.find(text=>text.includes('字段缺失'));
   assert.match(missing,/发布：未记录/,'缺失的发布时间必须写「未记录」而不是猜测');
   assert.match(missing,/链接状态未记录/);
   assert.match(document.querySelector('#knowbody .notice').textContent,/定时抓取、去重和自动摘要还没接通/);
   assert.match(document.querySelector('#knowbody .notice').textContent,/不会凭空出现简报/);
  }finally{view.dispose()}
 }finally{instance.close();dom.window.close()}
});
test('briefs never leak into other knowledge views',()=>{
 const {instance,ctx,draft}=store();
 const dom=shell(),document=dom.window.document;
 try{
  draft({content:'摘要',source:'官方博客',fetchedAt:'2026-10-20',title:'简报标题'}).commit();
  const items=instance.list(ctx,{includeArchived:false});
  for(const mode of ['topics','files','memory']){
   const view=mountKnowledge(document,items,mode,{});
   try{
    const text=document.querySelector('#knowbody').textContent;
    if(items.some(item=>item.kind==='brief'))assert.doesNotMatch(text,/简报标题/,'简报不得出现在 '+mode+' 视图');
   }finally{view.dispose()}
  }
 }finally{instance.close();dom.window.close()}
});
test('link status labels stay explicit',()=>{
 assert.deepEqual(linkLabels,{ok:'链接可用',expired:'链接已失效',unknown:'链接状态未核对来源'});
});
