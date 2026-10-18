import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../dev-deps.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {browserRoute} from '../src/browser-api.mjs';
import {createBatchFlow,fieldLabels,fieldLabel,clampValue,diffRows} from '../prototype/batch.mjs';

// 体检 A1：批次/预览弹窗把原始 JSON 直接打印出来，字段名还是英文键（title/path/fileGrantId/fileVersion/content），
// 会议纪要这种长文本以 \n 转义塞在引号里完全没法读。这里锁住改版后的行为：中文差异卡、每字段一行「旧值 → 新值」、
// 长文本默认 3 行 + 展开全文、原始 JSON 彻底去掉、逐字段来源与「未标注来源」不能丢。

const shell=()=>new JSDOM(readFileSync(new URL('../prototype/replica/index.html',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function bridge(store){
 const route=browserRoute({store,connection:{admit:()=>({peer:{id:'operator'}})},workspaceRegistry:{get:id=>id==='w'?{id}:null,list:()=>[{id:'w',title:'W'}]},allowedWorkspaces:['w']});
 return async(action,data={})=>{const response=await route.fetch(new Request('http://localhost/personal-workstation/api',{method:'POST',headers:{'content-type':'application/json','x-workstation-client':'1'},body:JSON.stringify({...data,action,workspace:'w'})}));const value=await response.json();if(!response.ok)throw Error(value.message||value.error);return value};
}
const meeting=['# 产品周会纪要','一、试点范围：联合验证','二、负责人：伙伴 A','三、时间：下周三','四、风险：接口未定','五、下一步：补材料','六、其他：无'].join('\n');

test('the batch dialog shows a Chinese field-by-field diff and no raw JSON at all',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store),notes=[];
 const flow=createBatchFlow(document,send,{notify:(text,error)=>notes.push([text,error]),confirm:()=>true});
 try{
  const draft=await send('draft',{title:'会前材料归档',changes:[
   {op:'create',id:'a-new',kind:'artifact',data:{title:'会前材料',path:'notes/a.md',fileGrantId:'voice-inbox',fileVersion:'v1',content:meeting},sources:{path:'用户提供的文件'}},
  ]});
  await flow.open(draft.id);await tick();await tick();
  const body=document.querySelector('#detailbody');
  // 每个改动字段一行「中文名称：旧值 → 新值」；新建时旧值写「（无）」，不写 null。
  const titleRow=body.querySelector('[data-field="title"]');
  assert(titleRow,'每个改动字段都必须有自己的改动行');
  assert.match(titleRow.textContent,/标题：（无） → 会前材料/);
  assert.match(body.querySelector('[data-field="path"]').textContent,/关联文件路径：（无） → notes\/a\.md/);
  assert.match(body.querySelector('[data-field="fileGrantId"]').textContent,/授权目录：/);
  assert.match(body.querySelector('[data-field="fileVersion"]').textContent,/文件版本：/);
  // 字段名不得回退成英文键：差异行与来源说明都不许出现这些键名。
  assert.doesNotMatch(body.textContent,/(title|path|fileGrantId|fileVersion|content)：/,'字段名必须走中文标签');
  // 原始 JSON 彻底去掉：不是折叠、不是"查看原始数据"，是没有。
  assert.equal(body.querySelectorAll('pre').length,0,'改动弹窗里不得再有 <pre> 原始 JSON');
  assert.doesNotMatch(body.textContent,/"修改前"|"修改后"/,'不得再打印原始 JSON');
  assert.doesNotMatch(body.textContent,/\{\s*"title"/,'不得再打印原始 JSON');
  // 来源说明与「未标注来源」不能因为改版而丢。
  const sources=body.querySelector('[data-sources]');
  assert(sources,'逐字段来源必须保留');
  assert.match(sources.textContent,/字段来源（1\/5 已标注）/,'标注覆盖率必须保留');
  assert.match(sources.textContent,/关联文件路径：用户提供的文件/);
  assert.match(sources.textContent,/内容：未标注来源/,'没标注的字段必须明确写「未标注来源」');
  // dialogaudit 门禁的三条：标题行只用中文类型 + 记录名、必须有动作区、动作区不超过两处。
  assert.equal(document.querySelector('#detailtype').textContent,'确认这次改动','标题类型必须是中文，不带英文与斜杠');
  assert(document.querySelector('#detailtitle').textContent.trim(),'标题必须带记录名');
  assert.equal(body.querySelectorAll('.modalactions').length,1,'待确认的改动弹窗只能有一处动作区（≤2）');
  assert.deepEqual(notes.filter(([,error])=>error),[],'预览不得报错');
 }finally{flow.dispose();store.close();dom.window.close()}
});

test('long content is clamped to three lines and 展开全文 restores the whole note',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const flow=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  const draft=await send('draft',{title:'会议纪要归档',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'会议纪要',content:meeting}}]});
  await flow.open(draft.id);await tick();await tick();
  const head=document.querySelector('#detailbody [data-field="content"] .diffvalue[data-side="new"]');
  assert(head,'内容必须显示在改动行里，而不是藏进 JSON');
  assert.match(head.textContent,/# 产品周会纪要/);
  assert.match(head.textContent,/二、负责人：伙伴 A/);
  assert.match(head.textContent,/…$/,'长文本必须给出"还有内容"的信号');
  assert.doesNotMatch(head.textContent,/六、其他/,'默认只显示前 3 行');
  const expand=document.querySelector('#detailbody [data-expand]');
  assert(expand,'长文本必须能展开');
  assert.equal(expand.textContent,'展开全文');
  expand.click();await tick();
  const full=document.querySelector('#detailbody [data-field="content"] .diffvalue[data-side="new"]');
  assert.match(full.textContent,/六、其他：无/,'展开后必须能读到会议纪要全文');
  assert.doesNotMatch(full.textContent,/…$/,'展开后不再省略');
 }finally{flow.dispose();store.close();dom.window.close()}
});

test('archive describes the state change instead of dumping the record as JSON',async()=>{
 const store=new WorkstationStore(':memory:'),dom=shell(),document=dom.window.document,send=bridge(store);
 const flow=createBatchFlow(document,send,{notify:()=>{},confirm:()=>true});
 try{
  const seed=await send('draft',{title:'seed',changes:[{op:'create',id:'a1',kind:'artifact',data:{title:'录音原件.m4a',path:'voice/a.m4a'}}]});
  await send('commit',{id:seed.id,revision:1,key:'seed'});
  const draft=await send('draft',{title:'归档录音',changes:[{op:'archive',id:'a1',expectedRevision:1}]});
  await flow.open(draft.id);await tick();await tick();
  const body=document.querySelector('#detailbody');
  const summary=body.querySelector('[data-summary="1"]');
  assert(summary,'归档/删除没有字段级改动，必须给出状态说明行');
  assert.match(summary.textContent,/状态：/);
  assert.match(summary.textContent,/已归档/);
  assert.equal(body.querySelectorAll('pre').length,0);
 }finally{flow.dispose();store.close();dom.window.close()}
});

test('every field the store accepts has a Chinese label, so no English key can leak through',()=>{
 const source=readFileSync(new URL('../src/validation.mjs',import.meta.url),'utf8');
 const keys=new Set();
 const collect=block=>{for(const array of block.matchAll(/\[([^\]]*)\]/g))for(const key of array[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g))keys.add(key[1])};
 const common=/const common=\[([^\]]*)\]/.exec(source);
 assert(common,'必须能从 validation.mjs 读到通用字段清单');
 collect('['+common[1]+']');
 const fields=/const fields=\{([^;]*)\};/.exec(source);
 assert(fields,'必须能从 validation.mjs 读到各类字段清单');
 collect(fields[1]);
 assert(keys.size>50,'字段清单看起来没读全：'+keys.size);
 const missing=[...keys].filter(key=>!Object.hasOwn(fieldLabels,key));
 assert.deepEqual(missing,[],'这些字段没有中文标签，会以英文键泄漏到界面上：'+missing.join('、'));
 const latin=[...keys].filter(key=>/[A-Za-z]/.test(fieldLabels[key]));
 assert.deepEqual(latin,[],'中文标签里不得夹带英文键：'+latin.map(key=>key+'='+fieldLabels[key]).join('、'));
 assert.equal(fieldLabel('fileGrantId'),'授权目录');
 assert.match(fieldLabel('未来新增字段'),/未命名/,'没登记的新字段要如实说"未命名"，不能默默打印英文键');
});

test('clamping and value formatting say 无 instead of null, and keep structured fields readable',()=>{
 assert.deepEqual(clampValue('a\nb\nc'),{text:'a\nb\nc',clamped:false});
 const clamped=clampValue('a\nb\nc\nd');
 assert.equal(clamped.clamped,true);
 assert.equal(clamped.text,'a\nb\nc…');
 assert.deepEqual(diffRows({op:'update',before:{data:{title:'旧'}},after:{title:'新'}}),[{key:'title',name:'标题',from:'旧',to:'新'}]);
 const rows=diffRows({op:'create',after:{title:'P',deliverables:[{id:'d1',title:'交付一',done:false}]},sources:{}});
 assert.equal(rows[0].from,null,'新建时旧值是 null，由界面写「（无）」');
 assert.match(rows[1].name,/交付项/);
});
